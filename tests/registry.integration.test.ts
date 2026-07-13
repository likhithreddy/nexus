import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { MCPRegistry } from "../src/aggregation/registry.js";
import { ConnectionManager } from "../src/aggregation/connectionManager.js";
import { createGateway } from "../src/server/gateway.js";
import { SQLiteStore } from "../src/memory/store.js";

const text = (s: string) => ({ type: "text" as const, text: s });

/** Build a real child MCP server on one end of an in-memory transport pair. */
function makeChildServer(
  name: string,
  tools: Tool[],
  handle: (toolName: string, args: unknown) => CallToolResult,
): { clientTransport: InMemoryTransport } {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return handle(req.params?.name ?? "", req.params?.arguments);
  });

  void server.connect(serverTransport);
  return { clientTransport };
}

const echoTool: Tool = {
  name: "echo",
  description: "Echo a message back.",
  inputSchema: { type: "object", properties: { msg: { type: "string" } } },
  annotations: { readOnlyHint: true },
};

const deleteTool: Tool = {
  name: "delete_thing",
  inputSchema: { type: "object" },
  annotations: { destructiveHint: true },
};

const searchTool: Tool = {
  name: "search",
  inputSchema: { type: "object" },
};

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn().catch(() => {})));
  cleanup = [];
});

describe("gateway end-to-end (child servers → registry → gateway → client)", () => {
  it("merges namespaced tools from multiple servers and reflects cacheability", async () => {
    const alpha = makeChildServer("alpha", [echoTool, deleteTool], (toolName, args) => ({
      content: [text(`echo:${JSON.stringify((args as { msg?: string } | undefined)?.msg ?? "")}`)],
    }));
    const beta = makeChildServer("beta", [searchTool], () => ({ content: [text("results")] }));

    const pairs = new Map([
      ["alpha", alpha.clientTransport],
      ["beta", beta.clientTransport],
    ]);
    const cm = new ConnectionManager({ buildTransport: (cfg) => pairs.get(cfg.name)! });
    const registry = new MCPRegistry(cm);

    await registry.addServer({ name: "alpha", transport: "stdio", command: "fake" });
    await registry.addServer({ name: "beta", transport: "stdio", command: "fake" });

    // Downstream MCP client ↔ Nexus gateway, over an in-memory pair.
    const [gwClientTransport, gwServerTransport] = InMemoryTransport.createLinkedPair();
    const gateway = createGateway(registry);
    await gateway.connect(gwServerTransport);
    const downstream = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await downstream.connect(gwClientTransport);

    cleanup.push(
      async () => { await downstream.close(); await gateway.close(); await registry.closeAll(); },
    );

    // tools/list is merged + namespaced.
    const listed = await downstream.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([
      "alpha.delete_thing",
      "alpha.echo",
      "beta.search",
    ]);
    // The cacheability seam (readOnlyHint) survives through the manifest.
    const echo = listed.tools.find((t) => t.name === "alpha.echo");
    expect(echo?.annotations?.readOnlyHint).toBe(true);

    // tools/call is routed to the owning child and its result is forwarded.
    const echoed = (await downstream.callTool({
      name: "alpha.echo",
      arguments: { msg: "hi" },
    })) as CallToolResult;
    const first = echoed.content[0];
    expect(first && "text" in first ? first.text : "").toBe('echo:"hi"');

    // A destructive tool still forwards (just flagged non-cacheable internally).
    const deleted = (await downstream.callTool({
      name: "alpha.delete_thing",
      arguments: {},
    })) as CallToolResult;
    expect(deleted.isError).toBeFalsy();

    // Unknown tool → isError result, not a thrown protocol error.
    const unknown = (await downstream.callTool({ name: "nope.x", arguments: {} })) as CallToolResult;
    expect(unknown.isError).toBe(true);
  });
});

describe("gateway end-to-end (resources + prompts)", () => {
  it("merges resources & prompts and forwards read/get to the owning child", async () => {
    // Child "docs" exposes one resource and one prompt.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const child = new Server(
      { name: "docs", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
    child.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    child.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: "docs://readme", name: "Readme", description: "the readme" }],
    }));
    child.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
      contents: [{ uri: req.params?.uri ?? "", mimeType: "text/plain", text: "body-of-readme" }],
    }));
    child.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [{ name: "summarize", description: "summarize a doc", arguments: [] }],
    }));
    child.setRequestHandler(GetPromptRequestSchema, async (req) => ({
      messages: [{ role: "user", content: { type: "text", text: `summarize:${req.params?.name}` } }],
    }));
    void child.connect(serverTransport);

    const cm = new ConnectionManager({ buildTransport: () => clientTransport });
    const registry = new MCPRegistry(cm);
    await registry.addServer({ name: "docs", transport: "stdio", command: "fake" });

    const [gwClientTransport, gwServerTransport] = InMemoryTransport.createLinkedPair();
    const gateway = createGateway(registry);
    await gateway.connect(gwServerTransport);
    const downstream = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await downstream.connect(gwClientTransport);
    cleanup.push(async () => {
      await downstream.close();
      await gateway.close();
      await registry.closeAll();
    });

    // resources/list keeps the original URI.
    const res = await downstream.listResources();
    expect(res.resources.map((r) => r.uri)).toEqual(["docs://readme"]);

    // resources/read is routed to the child.
    const read = await downstream.readResource({ uri: "docs://readme" });
    const c0 = read.contents[0];
    expect(c0 && "text" in c0 ? c0.text : "").toBe("body-of-readme");

    // prompts/list is namespaced (docs.summarize).
    const ps = await downstream.listPrompts();
    expect(ps.prompts.map((p) => p.name)).toEqual(["docs.summarize"]);

    // prompts/get routes by namespaced name back to the original.
    const g = await downstream.getPrompt({ name: "docs.summarize" });
    expect(g.messages.length).toBeGreaterThan(0);
  });
});

describe("gateway meta-tools (see memory/topology from the client)", () => {
  it("exposes nexus.* tools and handles them locally", async () => {
    const alpha = makeChildServer("alpha", [
      { name: "ping", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } } as Tool,
    ], () => ({
      content: [text("pong")],
    }));
    const pairs = new Map<string, InMemoryTransport>([["alpha", alpha.clientTransport]]);
    const cm = new ConnectionManager({ buildTransport: (cfg) => pairs.get(cfg.name)! });
    const registry = new MCPRegistry(cm);
    await registry.addServer({ name: "alpha", transport: "stdio", command: "fake" });

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-meta-"));
    const store = new SQLiteStore(path.join(tmp, "m.db"), 4);
    store.put({
      tool: "alpha.ping", argsFingerprint: "fp", argsText: "alpha\nping", resultJson: "{}",
      contributing: "c", servers: ["alpha"], embedding: null, createdAt: 1, expiresAt: null,
    });

    const [gwC, gwS] = InMemoryTransport.createLinkedPair();
    const gateway = createGateway(registry, {
      meta: { registry, servers: [{ name: "alpha", transport: "stdio" }], store },
    });
    await gateway.connect(gwS);
    const downstream = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await downstream.connect(gwC);
    cleanup.push(async () => {
      await downstream.close();
      await gateway.close();
      await registry.closeAll();
      store.close();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    const textOf = (r: CallToolResult): string => {
      const c = r.content[0];
      return c && "text" in c ? c.text : "";
    };

    const listed = await downstream.listTools();
    expect(listed.tools.some((t) => t.name === "nexus.memory_stats")).toBe(true);
    expect(listed.tools.some((t) => t.name === "nexus.graph")).toBe(true);
    expect(listed.tools.some((t) => t.name === "alpha.ping")).toBe(true);

    expect(textOf((await downstream.callTool({ name: "nexus.memory_stats", arguments: {} })) as CallToolResult)).toContain("1 cached");
    expect(textOf((await downstream.callTool({ name: "nexus.graph", arguments: {} })) as CallToolResult)).toContain("alpha");
    expect(textOf((await downstream.callTool({ name: "nexus.memory_forget", arguments: { server: "alpha" } })) as CallToolResult)).toMatch(/Forgot 1/);
  });
});
