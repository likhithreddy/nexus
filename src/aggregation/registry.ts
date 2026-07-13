import { EventEmitter } from "node:events";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolResult,
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { MergedManifest, ServerConfig } from "../types.js";
import { logger } from "../logging.js";
import { ConnectionManager, type ConnectedServer } from "./connectionManager.js";
import { discoverTools, discoverResources, discoverPrompts } from "./discovery.js";
import { buildNamespacedEntries, mergeEntries } from "./manifest.js";
import { normalizeServerName, namespaceToolName } from "./namespace.js";
import type { GraphInput, GraphTool } from "../graph.js";

/** Max length of a namespaced tool name per MCP SEP-986. */
const MAX_TOOL_NAME = 128;

export class UnknownToolError extends Error {
  constructor(public toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = "UnknownToolError";
  }
}

export class UnknownResourceError extends Error {
  constructor(public uri: string) {
    super(`Unknown resource: ${uri}`);
    this.name = "UnknownResourceError";
  }
}

export class UnknownPromptError extends Error {
  constructor(public promptName: string) {
    super(`Unknown prompt: ${promptName}`);
    this.name = "UnknownPromptError";
  }
}

export class ServerUnavailableError extends Error {
  constructor(public serverName: string) {
    super(`Server not connected: ${serverName}`);
    this.name = "ServerUnavailableError";
  }
}

export interface RegistryEventMap {
  "tools-reloaded": { tools: Tool[] };
  "server-added": { name: string };
  "server-removed": { name: string };
  "server-error": { name: string; error: Error };
}

/**
 * The MCP aggregation registry: owns the set of connected child servers, the
 * merged tool manifest, and the route table that maps a namespaced tool name
 * back to (server, originalName). Re-derives the manifest from cached discovery
 * results on every add/remove — cheap, and avoids incremental bookkeeping bugs.
 *
 * Emits "tools-reloaded" whenever the merged manifest changes, so the gateway
 * can notify downstream clients via `notifications/tools/list_changed`.
 */
export class MCPRegistry extends EventEmitter {
  private connections = new Map<string, ConnectedServer>();
  private cm: ConnectionManager;
  private manifest: MergedManifest = { tools: [], routes: new Map(), duplicates: [] };
  private resources: Resource[] = [];
  private resourceRoutes = new Map<string, string>(); // uri -> serverName
  private prompts: Prompt[] = [];
  private promptRoutes = new Map<string, { serverName: string; originalName: string }>();

  /** @param cm inject a ConnectionManager (tests use one with an in-memory transport). */
  constructor(cm?: ConnectionManager) {
    super();
    this.cm = cm ?? new ConnectionManager();
  }

  get tools(): Tool[] {
    return this.manifest.tools;
  }

  listTools(): Tool[] {
    return this.manifest.tools;
  }

  listResources(): Resource[] {
    return this.resources;
  }

  listPrompts(): Prompt[] {
    return this.prompts;
  }

  getRoute(name: string) {
    return this.manifest.routes.get(name);
  }

  /** Build a topology snapshot (for `nexus graph` and the `nexus.graph` meta-tool). */
  toGraphInput(
    servers: { name: string; transport: string; enabled?: boolean }[],
    byServer: Record<string, number>,
  ): GraphInput {
    const toolsByServer = new Map<string, GraphTool[]>();
    for (const t of this.listTools()) {
      const route = this.getRoute(t.name);
      const srv = route?.serverName ?? "?";
      const arr = toolsByServer.get(srv) ?? [];
      arr.push({ name: t.name, description: t.description, cacheable: route?.cacheable ?? false });
      toolsByServer.set(srv, arr);
    }
    return {
      servers,
      toolsByServer,
      connected: new Set(this.serverNames()),
      failed: new Set(),
      byServer,
    };
  }

  hasServer(name: string): boolean {
    return this.connections.has(name);
  }

  serverNames(): string[] {
    return [...this.connections.keys()];
  }

  /** Connect to a child server, discover its tools, merge into the manifest. */
  async addServer(config: ServerConfig): Promise<void> {
    const name = normalizeServerName(config.name);
    if (name !== config.name) {
      logger.warn({ requested: config.name, normalized: name }, "server name normalized for namespacing");
    }
    if (this.connections.has(name)) {
      await this.removeServer(name);
    }

    const client = await this.cm.connect({ ...config, name });
    let tools: Tool[];
    try {
      tools = await discoverTools(client);
    } catch (err) {
      await this.cm.disconnect(client).catch(() => {});
      throw err;
    }
    // Resources/prompts are optional; a server without those capabilities
    // returns method-not-found, which we treat as "none".
    const resources = await discoverResources(client).catch((e) => {
      logger.debug({ server: name, err: e.message }, "no resources");
      return [] as Resource[];
    });
    const prompts = await discoverPrompts(client).catch((e) => {
      logger.debug({ server: name, err: e.message }, "no prompts");
      return [] as Prompt[];
    });

    this.connections.set(name, { config: { ...config, name }, client, tools, resources, prompts });
    this.rebuild();
    logger.info(
      { server: name, transport: config.transport, tools: tools.length, resources: resources.length, prompts: prompts.length },
      "server connected",
    );
    this.emit("server-added", { name });
    this.emit("tools-reloaded", { tools: this.manifest.tools });
  }

  /** Disconnect a server and drop its tools from the manifest. */
  async removeServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    await this.cm.disconnect(conn.client).catch((err) =>
      logger.warn({ server: name, err: err.message }, "error during disconnect"),
    );
    this.connections.delete(name);
    this.rebuild();
    logger.info({ server: name }, "server removed");
    this.emit("server-removed", { name });
    this.emit("tools-reloaded", { tools: this.manifest.tools });
  }

  /**
   * Connect every server in `configs`. Tolerant: a single failing server is
   * reported via "server-error" (and logged) without aborting the rest.
   * Returns the set of names that connected successfully.
   */
  async reloadAll(configs: ServerConfig[]): Promise<{ ok: string[]; failed: string[] }> {
    const ok: string[] = [];
    const failed: string[] = [];
    for (const config of configs) {
      if (config.enabled === false) {
        logger.info({ server: config.name }, "server disabled, skipping");
        continue;
      }
      try {
        await this.addServer(config);
        ok.push(normalizeServerName(config.name));
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        failed.push(config.name);
        logger.error({ server: config.name, err: error.message }, "failed to connect server");
        this.emit("server-error", { name: config.name, error });
      }
    }
    return { ok, failed };
  }

  /** Forward a tools/call to the owning child server. */
  async callTool(namespacedName: string, args: unknown): Promise<CallToolResult> {
    const route = this.manifest.routes.get(namespacedName);
    if (!route) throw new UnknownToolError(namespacedName);
    const conn = this.connections.get(route.serverName);
    if (!conn) throw new ServerUnavailableError(route.serverName);

    // Transparent proxy: forward the child's result as-is. The SDK's callTool
    // return type is a union that includes a legacy "compatibility" variant
    // (no `content`), so we cast to the protocol shape we know a conforming
    // child always returns. No schema validation here — the gateway stays
    // transparent and forwards whatever the child produced.
    const result = await conn.client.callTool({
      name: route.originalName,
      arguments: args as Record<string, unknown> | undefined,
    });
    return result as unknown as CallToolResult;
  }

  /** Forward a resources/read to the owning child server (routed by URI). */
  async readResource(uri: string): Promise<ReadResourceResult> {
    const serverName = this.resourceRoutes.get(uri);
    if (!serverName) throw new UnknownResourceError(uri);
    const conn = this.connections.get(serverName);
    if (!conn) throw new ServerUnavailableError(serverName);
    const result = await conn.client.readResource({ uri });
    return result as unknown as ReadResourceResult;
  }

  /** Forward a prompts/get to the owning child server (namespaced name). */
  async getPrompt(namespacedName: string, args?: unknown): Promise<GetPromptResult> {
    const route = this.promptRoutes.get(namespacedName);
    if (!route) throw new UnknownPromptError(namespacedName);
    const conn = this.connections.get(route.serverName);
    if (!conn) throw new ServerUnavailableError(route.serverName);
    const result = await conn.client.getPrompt({
      name: route.originalName,
      arguments: args as Record<string, string> | undefined,
    });
    return result as unknown as GetPromptResult;
  }

  /** Disconnect everything (process shutdown). */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map((c) => this.cm.disconnect(c.client).catch(() => {})),
    );
    this.connections.clear();
    this.manifest = { tools: [], routes: new Map(), duplicates: [] };
    this.resources = [];
    this.resourceRoutes = new Map();
    this.prompts = [];
    this.promptRoutes = new Map();
  }

  private rebuild(): void {
    const perServer = [...this.connections.values()].map((c) =>
      buildNamespacedEntries(c.config.name, c.tools),
    );
    this.manifest = mergeEntries(perServer);

    if (this.manifest.duplicates.length > 0) {
      logger.warn(
        { duplicates: this.manifest.duplicates },
        "duplicate namespaced tool names detected (kept first)",
      );
    }
    for (const t of this.manifest.tools) {
      if (t.name.length > MAX_TOOL_NAME) {
        logger.warn(
          { tool: t.name, length: t.name.length },
          "namespaced tool name exceeds 128 chars (MCP SEP-986) — may be rejected by clients",
        );
      }
    }

    // Resources: route by URI, preserve original URI. First server wins on collision.
    const resources: Resource[] = [];
    const resourceRoutes = new Map<string, string>();
    // Prompts: namespace the name like tools (server.name).
    const prompts: Prompt[] = [];
    const promptRoutes = new Map<string, { serverName: string; originalName: string }>();
    for (const c of this.connections.values()) {
      for (const r of c.resources) {
        if (resourceRoutes.has(r.uri)) {
          logger.warn({ uri: r.uri }, "duplicate resource URI (kept first)");
          continue;
        }
        resourceRoutes.set(r.uri, c.config.name);
        resources.push(r);
      }
      for (const p of c.prompts) {
        const ns = namespaceToolName(c.config.name, p.name);
        if (promptRoutes.has(ns)) {
          logger.warn({ prompt: ns }, "duplicate namespaced prompt (kept first)");
          continue;
        }
        promptRoutes.set(ns, { serverName: c.config.name, originalName: p.name });
        prompts.push({ ...p, name: ns });
      }
    }
    this.resources = resources;
    this.resourceRoutes = resourceRoutes;
    this.prompts = prompts;
    this.promptRoutes = promptRoutes;
  }
}
