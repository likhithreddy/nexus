import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CreateMessageResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import { logger } from "../logging.js";
import { MCPRegistry } from "../aggregation/registry.js";
import type { MemoryCache } from "../memory/cache.js";
import { META_TOOL_DEFS, isMetaTool, callMetaTool, type MetaContext } from "./meta-tools.js";

export interface GatewayOptions {
  /** When set, cacheable tool calls are served from / stored in memory. */
  memory?: MemoryCache;
  /** When set, Nexus exposes `nexus.*` meta-tools (memory + topology) to the client. */
  meta?: MetaContext;
  /** Filled with an MCP-sampling function so the verifier can ask the client's LLM. */
  samplerHolder?: { current?: (prompt: string) => Promise<string> };
}

/**
 * Build Nexus-as-an-MCP-server: the gateway shape (PRD §10.1). Exposes the
 * merged tools / resources / prompts and forwards calls/reads/gets to the owning
 * child server via the registry's route tables.
 *
 * With `memory` set, cacheable (read-only/idempotent) tool calls are intercepted;
 * otherwise the gateway is a pure passthrough.
 */
export function createGateway(registry: MCPRegistry, opts: GatewayOptions = {}): Server {
  const server = new Server(
    { name: PRODUCT_NAME, version: VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
    },
  );

  // Expose an MCP-sampling function so the verifier can ask the client's LLM.
  if (opts.samplerHolder) {
    opts.samplerHolder.current = async (prompt: string): Promise<string> => {
      const result = await server.request(
        {
          method: "sampling/createMessage",
          params: {
            maxTokens: 5,
            messages: [{ role: "user", content: { type: "text", text: prompt } }],
          },
        },
        CreateMessageResultSchema,
      );
      const content = (result as { content?: { type: string; text?: string } }).content;
      return content?.text ?? "";
    };
  }

  // --- Tools ---
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...registry.listTools(), ...(opts.meta ? META_TOOL_DEFS : [])],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name;
    const args = request.params?.arguments;
    if (!name) {
      return errorResult("Malformed tools/call request: missing tool name");
    }
    // Nexus meta-tools (memory/topology inspection) — handled locally.
    if (opts.meta && isMetaTool(name)) {
      return await callMetaTool(name, args, opts.meta);
    }
    const route = registry.getRoute(name);
    if (!route) {
      return errorResult(`Unknown tool: ${name}. Use tools/list to see available tools.`);
    }
    try {
      if (opts.memory) {
        const outcome = await opts.memory.callWithMemory(name, route, args, () =>
          registry.callTool(name, args),
        );
        logger.debug({ tool: name, source: outcome.source }, "memory resolved");
        return outcome.result;
      }
      return await registry.callTool(name, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ tool: name, err: message }, "tool call failed");
      return errorResult(`Tool '${name}' failed: ${message}`);
    }
  });

  // --- Resources (routed by URI) ---
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: registry.listResources(),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params?.uri;
    if (!uri) throw new Error("Malformed resources/read request: missing uri");
    return await registry.readResource(uri); // throws UnknownResourceError → client error
  });

  // --- Prompts (namespaced like tools) ---
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: registry.listPrompts(),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params?.name;
    const args = request.params?.arguments;
    if (!name) throw new Error("Malformed prompts/get request: missing name");
    return await registry.getPrompt(name, args); // throws UnknownPromptError → client error
  });

  // Live reload: when servers are added/removed mid-session, nudge clients to
  // re-fetch the merged manifests (PRD §10.2 "reloaded" event).
  registry.on("tools-reloaded", () => {
    server.sendToolListChanged().catch((err) =>
      logger.warn({ err: err.message }, "failed to send tools/list_changed"),
    );
    server.sendResourceListChanged().catch(() => {});
    server.sendPromptListChanged().catch(() => {});
  });

  return server;
}

function errorResult(text: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  };
}
