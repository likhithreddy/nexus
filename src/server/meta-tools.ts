import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MCPRegistry } from "../aggregation/registry.js";
import type { SQLiteStore } from "../memory/store.js";
import { renderGraph } from "../graph.js";

/**
 * Nexus "meta-tools" — the MCP-native way to see memory and topology from any
 * connected client. When enabled, Nexus exposes a small set of `nexus.*` tools
 * alongside the child servers' tools, so the AI client itself can ask
 * "what's in memory?" or "show me the topology" (the "plugin to see memory").
 *
 * Opt-in (env `NEXUS_META_TOOLS=1`) so the default tool list stays clean.
 */

export const META_PREFIX = "nexus.";

export interface MetaContext {
  registry: MCPRegistry;
  servers: { name: string; transport: string; enabled?: boolean }[];
  store?: SQLiteStore;
}

function text(t: string): CallToolResult {
  return { content: [{ type: "text" as const, text: t }] };
}

export const META_TOOL_DEFS: Tool[] = [
  {
    name: "nexus.memory_stats",
    description: "Show Nexus memory cache stats: entry count and per-server breakdown.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "nexus.memory_list",
    description: "List cached tool results, optionally filtered by server and/or namespaced tool.",
    inputSchema: {
      type: "object",
      properties: { server: { type: "string" }, tool: { type: "string" }, limit: { type: "number" } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "nexus.graph",
    description: "Show the Nexus topology: connected servers, their tools, and memory counts.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "nexus.memory_forget",
    description: "Drop cached entries by server and/or namespaced tool name.",
    inputSchema: { type: "object", properties: { server: { type: "string" }, tool: { type: "string" } } },
  },
];

export function isMetaTool(name: string): boolean {
  return META_TOOL_DEFS.some((t) => t.name === name);
}

export async function callMetaTool(
  name: string,
  args: unknown,
  ctx: MetaContext,
): Promise<CallToolResult> {
  const a = (args ?? {}) as { server?: string; tool?: string; limit?: number };
  switch (name) {
    case "nexus.memory_stats": {
      if (!ctx.store) return text("Memory is disabled.");
      const s = ctx.store.stats();
      const by = Object.entries(s.byServer)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      return text(`${s.entries} cached entries\nBy server:\n${by || "  (none)"}`);
    }
    case "nexus.memory_list": {
      if (!ctx.store) return text("Memory is disabled.");
      const entries = ctx.store.listEntries({ server: a.server, tool: a.tool, limit: a.limit ?? 50 });
      if (entries.length === 0) return text("No matching cached entries.");
      return text(entries.map((e) => `${e.tool}\t${e.argsText.slice(0, 80)}`).join("\n"));
    }
    case "nexus.graph": {
      const byServer = ctx.store ? ctx.store.stats().byServer : {};
      return text(renderGraph(ctx.registry.toGraphInput(ctx.servers, byServer)));
    }
    case "nexus.memory_forget": {
      if (!ctx.store) return text("Memory is disabled.");
      let n = 0;
      if (a.server) n += ctx.store.invalidateServer(a.server);
      if (a.tool) n += ctx.store.forgetTool(a.tool);
      return text(`Forgot ${n} cached entry(ies).`);
    }
    default:
      return text(`Unknown nexus meta tool: ${name}`);
  }
}
