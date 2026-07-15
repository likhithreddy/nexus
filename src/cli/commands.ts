import { parseArgs } from "node:util";
import path from "node:path";
import http from "node:http";
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, upsertServer, removeServer, findServer } from "../config/store.js";
import { findCatalogEntry } from "../config/catalog.js";
import { getNexusHome } from "../config/paths.js";
import type { ParsedServerConfig } from "../config/schema.js";
import type { CatalogEntry, ServerConfig } from "../types.js";
import { MCPRegistry } from "../aggregation/registry.js";
import { ConnectionManager } from "../aggregation/connectionManager.js";
import { createGateway } from "../server/gateway.js";
import { SQLiteStore } from "../memory/store.js";
import { OpenAIEmbedder, HashEmbedder, LocalEmbedder, type Embedder } from "../memory/embeddings.js";
import { MemoryCache } from "../memory/cache.js";
import { buildTtlResolver, composeTtlResolver, parseDuration } from "../memory/ttl.js";
import { SamplingVerifier } from "../memory/verifier.js";
import { getDefaultSecretStore, type SecretStore } from "../secrets/store.js";
import { renderGraph } from "../graph.js";
import { select } from "@inquirer/prompts";
import { startBackend } from "../backend/server.js";
import { logger } from "../logging.js";

/** Parse "KEY=VALUE" or "KEY:VALUE" into a tuple. */
function parseKv(s: string): [string, string] {
  const i = s.indexOf("=");
  const j = s.indexOf(":");
  let idx = -1;
  if (i !== -1 && (j === -1 || i < j)) idx = i;
  else if (j !== -1) idx = j;
  if (idx === -1) throw new Error(`expected KEY=VALUE or KEY:VALUE, got '${s}'`);
  return [s.slice(0, idx), s.slice(idx + 1)];
}

function toRecord(pairs: string[] | undefined): Record<string, string> {
  return Object.fromEntries((pairs ?? []).map(parseKv));
}

/** Run the Nexus gateway over stdio (the deployable MCP server shape). */
export async function cmdServe(): Promise<void> {
  const config = await loadConfig();
  const secretStore = getDefaultSecretStore();
  const registry = new MCPRegistry(new ConnectionManager({ secretStore }));
  registry.on("server-removed", ({ name }) => {
    // PRD §12: purge a removed server's secrets from the keychain.
    void secretStore?.deleteServer(name).catch((e) =>
      logger.warn({ server: name, err: e.message }, "failed to delete keychain secrets"),
    );
  });

  // Memory is ON by default — it's the product's whole point. Opt out with
  // NEXUS_MEMORY=0. Provider: local bge-small (default, keyless) | openai
  // (NEXUS_EMBEDDING=openai + key) | hash (test).
  const embedding = process.env.NEXUS_EMBEDDING;
  const memoryOn = process.env.NEXUS_MEMORY !== "0";
  let memory: MemoryCache | undefined;
  const samplerHolder: { current?: (prompt: string) => Promise<string> } = {};
  if (memoryOn) {
    const provider = embedding === "openai" ? "openai" : embedding === "hash" ? "hash" : "local";
    const nominalDim = provider === "openai" ? 1536 : provider === "hash" ? 16 : 384;
    let embedder: Embedder | undefined;
    try {
      embedder =
        provider === "openai" ? new OpenAIEmbedder() :
        provider === "hash" ? new HashEmbedder(16) :
        new LocalEmbedder();
      if (provider === "local") {
        logger.info("memory: warming up local embedder (model downloads on first use)…");
        await embedder.embed(["warmup"]);
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, provider }, "embedder unavailable; exact-match only");
      embedder = undefined;
    }
    try {
      const storePath = path.join(getNexusHome(), "memory.db");
      const store = new SQLiteStore(storePath, nominalDim);
      const explicit = buildTtlResolver(config.ttl ?? {});
      const ttlFor = composeTtlResolver({
        explicit,
        heuristics: config.ttlHeuristics === true,
        heuristicTtlMs: config.heuristicTtlMs ? parseDuration(config.heuristicTtlMs) : undefined,
      });
      if (config.ttlHeuristics) logger.info({ heuristicTtlMs: config.heuristicTtlMs ?? "5m" }, "TTL heuristics enabled");
      // Gray-zone verifier: harness-driven (MCP sampling), keyless.
      const verifier = new SamplingVerifier({
        sample: async (p) => {
          if (!samplerHolder.current) throw new Error("sampling not connected");
          return samplerHolder.current(p);
        },
      });
      memory = new MemoryCache({ store, embedder, ttlFor, verifier });
      // PRD §8: drop cache entries contributed by a removed server on config change.
      registry.on("server-removed", ({ name }) => {
        const n = memory?.invalidateServer(name) ?? 0;
        if (n) logger.info({ server: name, invalidated: n }, "invalidated memory entries");
      });
      logger.info({ provider, dim: embedder?.dimension ?? nominalDim, storePath }, "memory enabled");
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "memory store init failed; running without memory (needs Node 22+ for node:sqlite)",
      );
    }
  } else {
    logger.info("memory disabled (NEXUS_MEMORY=0) — pure aggregation");
  }

  const { ok, failed } = await registry.reloadAll(config.servers);
  logger.info({ connected: ok.length, failed }, "registry loaded");

  // Meta-tools (nexus.*): let the connected client inspect memory/topology.
  const metaOn = process.env.NEXUS_META_TOOLS === "1";
  if (metaOn) logger.info("meta-tools enabled (nexus.*)");
  const meta = metaOn ? { registry, servers: config.servers, store: memory?.store } : undefined;

  const server = createGateway(registry, { memory, meta, samplerHolder });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("nexus gateway ready on stdio");

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, "shutting down");
    await registry.closeAll();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/** Run the Nexus backend HTTP server (for the VS Code extension). */
export async function cmdBackend(opts: { port?: number; host?: string; token?: string }): Promise<void> {
  logger.info({ port: opts.port ?? "ephemeral", host: opts.host ?? "127.0.0.1" }, "starting backend…");
  const { close } = await startBackend(opts);
  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, "backend shutting down");
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

export async function cmdListServers(json: boolean): Promise<void> {
  const config = await loadConfig();
  if (json) {
    process.stdout.write(JSON.stringify(config.servers, null, 2) + "\n");
    return;
  }
  if (config.servers.length === 0) {
    console.log("No servers configured. Use `nexus add <name>` (catalog) or `nexus add --transport ...` (freeform).");
    return;
  }
  for (const s of config.servers) {
    const mark = s.enabled === false ? "[off]" : "[on] ";
    const target = s.transport === "stdio" ? `${s.command ?? "?"} ${(s.args ?? []).join(" ")}` : (s.url ?? "?");
    console.log(`${mark} ${s.name.padEnd(16)} ${s.transport.padEnd(16)} ${target}`);
  }
}

export async function cmdListTools(opts: { json?: boolean; tree?: boolean } = {}): Promise<void> {
  const config = await loadConfig();
  if (config.servers.length === 0) {
    console.log("No servers configured.");
    return;
  }
  const registry = new MCPRegistry();
  const { ok, failed } = await registry.reloadAll(config.servers);

  if (opts.json) {
    const tools = registry.listTools();
    await registry.closeAll();
    process.stdout.write(JSON.stringify(tools, null, 2) + "\n");
    return;
  }

  // Collect rows with the ORIGINAL (un-prefixed) tool name BEFORE closeAll.
  const byServer = new Map<string, { original: string; cache: boolean; desc: string }[]>();
  for (const t of registry.listTools()) {
    const route = registry.getRoute(t.name);
    const srv = route?.serverName ?? "?";
    const arr = byServer.get(srv) ?? [];
    arr.push({
      original: route?.originalName ?? t.name,
      cache: route?.cacheable ?? false,
      desc: ((t.description ?? "").split("\n")[0] ?? "").slice(0, 70),
    });
    byServer.set(srv, arr);
  }
  if (opts.tree) {
    // Topology view (same output as the old "nexus graph"): server status
    // markers (●/✕/○), cache counts, tools with [cacheable] tags. Built
    // BEFORE closeAll (toGraphInput reads the route table).
    let byServerCounts: Record<string, number> = {};
    const dbPath = path.join(getNexusHome(), "memory.db");
    if (existsSync(dbPath)) {
      const s = new SQLiteStore(dbPath, 1);
      try { byServerCounts = s.stats().byServer; } finally { s.close(); }
    }
    const gi = registry.toGraphInput(config.servers, byServerCounts);
    gi.failed = new Set(failed);
    await registry.closeAll();
    process.stdout.write(renderGraph(gi) + "\n");
    return;
  }

  // Default: tools grouped under each server (per-server sub-tables).
  await registry.closeAll();

  if (failed.length > 0) {
    console.error(`(connected: ${ok.length}; failed: ${failed.join(", ")})`);
  }
  const allRows = [...byServer.values()].flat();
  if (allRows.length === 0 && ok.length === 0) {
    console.log("No tools discovered.");
    return;
  }

  const wTool = Math.min(34, Math.max(8, ...allRows.map((r) => r.original.length)));
  for (const s of config.servers) {
    const connected = ok.includes(s.name);
    const rows = byServer.get(s.name) ?? [];
    if (!connected) {
      console.log(`\n✕ ${s.name} [${s.transport}] — not connected${failed.includes(s.name) ? " (failed)" : " (disabled)"}`);
      continue;
    }
    const cacheable = rows.filter((r) => r.cache).length;
    console.log(`\n● ${s.name} [${s.transport}]  —  ${rows.length} tool${rows.length === 1 ? "" : "s"}, ${cacheable} cacheable`);
    if (rows.length === 0) {
      console.log("    (no tools)");
      continue;
    }
    console.log(`  ${"TOOL".padEnd(wTool)}  CACHE  DESCRIPTION`);
    for (const r of rows) {
      const tool = r.original.length > wTool ? `${r.original.slice(0, wTool - 1)}…` : r.original.padEnd(wTool);
      console.log(`  ${tool}  ${(r.cache ? "yes" : "no").padEnd(5)}  ${r.desc}`);
    }
  }
}

/** Format a positive millisecond duration compactly (10s / 5m / 3h / 2d). */
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Inspect the memory store directly (`nexus memory stats|list|forget`), no serve
 * required. Dimension passed to SQLiteStore is irrelevant for an existing db
 * (CREATE ... IF NOT EXISTS is a no-op).
 */
export async function cmdMemory(sub: string | undefined, rest: string[]): Promise<void> {
  const dbPath = path.join(getNexusHome(), "memory.db");
  if (!existsSync(dbPath)) {
    console.log(
      `No memory store at ${dbPath}.\nRun 'nexus serve' once to create it (memory is on by default).`,
    );
    return;
  }
  const store = new SQLiteStore(dbPath, 1);
  const now = Date.now();
  try {
    switch (sub) {
      case "stats": {
        const s = store.stats();
        const total = s.hits + s.misses;
        const rate = total > 0 ? Math.round((s.hits / total) * 100) : 0;
        console.log(`${s.entries} cached entry(ies)  ·  ${s.hits} hits, ${s.misses} misses (${rate}% hit rate)`);
        const servers = Object.entries(s.byServer).sort((a, b) => b[1] - a[1]);
        if (servers.length) {
          console.log("\nBy server:");
          for (const [srv, n] of servers) console.log(`  ${srv.padEnd(20)} ${n}`);
        }
        break;
      }
      case "list": {
        const { values } = parseArgs({
          args: rest,
          options: { server: { type: "string" }, tool: { type: "string" }, limit: { type: "string" } },
          allowPositionals: true,
        });
        const limit = values.limit ? Number(values.limit) : 50;
        const entries = store.listEntries({ server: values.server, tool: values.tool, limit });
        if (entries.length === 0) {
          console.log("No matching cached entries.");
          break;
        }
        for (const e of entries) {
          const age = fmtDuration(now - e.createdAt);
          const exp = e.expiresAt == null ? "never" : `${fmtDuration(e.expiresAt - now)} left`;
          const args = e.argsText.length > 60 ? `${e.argsText.slice(0, 60)}…` : e.argsText;
          console.log(`  ${e.tool}  (age ${age}, exp ${exp})\n    ${args}`);
        }
        break;
      }
      case "show": {
        const toolName = rest[0];
        if (!toolName) throw new Error("Usage: nexus memory show <tool-name>");
        const entries = store.listEntries({ tool: toolName, limit: 10 });
        if (entries.length === 0) {
          console.log(`No cached entries for '${toolName}'.`);
          break;
        }
        for (const e of entries) {
          const age = fmtDuration(now - e.createdAt);
          console.log(`\n${e.tool}  (age ${age})`);
          console.log(`  args: ${e.argsText}`);
          console.log(`  result:`);
          try {
            const parsed = JSON.parse(e.resultJson);
            console.log(JSON.stringify(parsed, null, 2));
          } catch {
            console.log(e.resultJson);
          }
        }
        break;
      }
      case "forget": {
        const { values } = parseArgs({
          args: rest,
          options: { server: { type: "string" }, tool: { type: "string" } },
          allowPositionals: true,
        });
        if (!values.server && !values.tool) {
          // Interactive: pick from available cache entries
          if (!process.stdin.isTTY) {
            throw new Error("Usage: nexus memory forget [--server S] [--tool T]");
          }
          const entries = store.listEntries({ limit: 100 });
          if (entries.length === 0) {
            console.log("No cached entries to forget.");
            break;
          }
          const tools = [...new Set(entries.map((e) => e.tool))];
          const choice = await select({
            message: "What to forget?",
            choices: [
              ...tools.map((t) => ({ name: t, value: t })),
              { name: "All entries", value: "__all__" },
              { name: "Cancel", value: "__cancel__" },
            ],
          });
          if (choice === "__cancel__") {
            console.log("Cancelled.");
            break;
          }
          if (choice === "__all__") {
            let n = 0;
            for (const t of tools) n += store.forgetTool(t);
            store.resetStats();
            console.log(`Forgot ${n} cached entry(ies).`);
            break;
          }
          const n = store.forgetTool(choice);
          store.resetStats();
          console.log(`Forgot ${n} cached entr${n === 1 ? "y" : "ies"} (${choice}).`);
          break;
        }
        let n = 0;
        if (values.server) n += store.invalidateServer(values.server);
        if (values.tool) n += store.forgetTool(values.tool);
        store.resetStats();
        console.log(`Forgot ${n} cached entry(ies).`);
        break;
      }
      default:
        console.log("Usage: nexus memory <stats|list|show|forget> [--server S] [--tool T] [--limit N]");
    }
  } finally {
    store.close();
  }
}

/** `nexus graph` — live topology: servers → tools (cacheable), connection + memory counts. */
export async function cmdGraph(): Promise<void> {
  const config = await loadConfig();
  const registry = new MCPRegistry(new ConnectionManager());
  const { failed } = await registry.reloadAll(config.servers);

  let byServer: Record<string, number> = {};
  const dbPath = path.join(getNexusHome(), "memory.db");
  if (existsSync(dbPath)) {
    const s = new SQLiteStore(dbPath, 1);
    try {
      byServer = s.stats().byServer;
    } finally {
      s.close();
    }
  }

  const gi = registry.toGraphInput(config.servers, byServer);
  gi.failed = new Set(failed);
  process.stdout.write(renderGraph(gi) + "\n");
  await registry.closeAll();
}

/** Pure HTML renderer for the dashboard (testable without a server). */
export function dashboardHtml(d: {
  graph: string;
  entries: number;
  byServer: Record<string, number>;
  serverCount: number;
  generatedAt: string;
}): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows =
    Object.entries(d.byServer)
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`)
      .join("") || '<tr><td colspan="2">(none)</td></tr>';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10">
<title>Nexus</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:64rem;color:#111}
pre{background:#f4f4f5;padding:1rem;border-radius:.5rem;white-space:pre-wrap;overflow-x:auto}
table{border-collapse:collapse;margin-top:.5rem}td,th{border:1px solid #ddd;padding:.35rem .7rem;text-align:left}
code{background:#f4f4f5;padding:.1rem .3rem;border-radius:.25rem}</style>
</head><body>
<h1>Nexus</h1>
<p><strong>${d.serverCount}</strong> configured server(s) · <strong>${d.entries}</strong> cached entries · generated ${esc(
    d.generatedAt,
  )} · auto-refresh 10s</p>
<h2>Topology</h2>
<pre>${esc(d.graph)}</pre>
<h2>Memory by server</h2>
<table><tr><th>server</th><th>cached entries</th></tr>${rows}</table>
<p><small>CLI equivalents: <code>nexus graph</code> · <code>nexus memory stats</code></small></p>
</body></html>`;
}

/**
 * `nexus dashboard` — serve a live HTML view (topology snapshot from startup +
 * fresh memory stats per request) on localhost. Ctrl-C to stop.
 */
export async function cmdDashboard(port: number): Promise<void> {
  const config = await loadConfig();
  const registry = new MCPRegistry(new ConnectionManager());
  await registry.reloadAll(config.servers);
  const servers = config.servers;

  const httpServer = http.createServer((_req, res) => {
    try {
      let entries = 0;
      let byServer: Record<string, number> = {};
      const dbPath = path.join(getNexusHome(), "memory.db");
      if (existsSync(dbPath)) {
        const s = new SQLiteStore(dbPath, 1);
        try {
          const st = s.stats();
          entries = st.entries;
          byServer = st.byServer;
        } finally {
          s.close();
        }
      }
      const gi = registry.toGraphInput(servers, byServer);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        dashboardHtml({
          graph: renderGraph(gi),
          entries,
          byServer,
          serverCount: servers.length,
          generatedAt: new Date().toLocaleString(),
        }),
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end((err as Error).message);
    }
  });

  httpServer.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Nexus dashboard → ${url}\n  Press Ctrl-C to stop.\n`);
    if (process.platform === "darwin") exec(`open ${url}`);
    else if (process.platform === "linux") exec(`xdg-open ${url} 2>/dev/null || true`);
  });
  const shutdown = (): void => {
    void registry.closeAll().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function cmdRemove(name: string | undefined, deps: { secretStore?: SecretStore } = {}): Promise<void> {
  if (!name) throw new Error("Usage: nexus remove <name>");
  const config = await loadConfig();
  if (!findServer(config, name)) throw new Error(`No server named '${name}'.`);
  const secretStore = deps.secretStore ?? getDefaultSecretStore();
  await secretStore?.deleteServer(name).catch((e) =>
    logger.warn({ server: name, err: e.message }, "failed to delete keychain secrets"),
  );
  await removeServer(config, name);
  console.log(`Removed server '${name}'${secretStore ? " (and its keychain secrets)" : ""}.`);
}

function catalogEntryToConfig(
  e: CatalogEntry,
  overrides: { headers: Record<string, string>; enabled: boolean },
): ParsedServerConfig {
  return {
    name: e.name,
    transport: e.transport,
    command: e.command,
    args: e.args,
    url: e.url,
    headers: { ...e.headers, ...overrides.headers },
    env: {},
    secretEnv: [],
    authType: e.authType ?? "none",
    requiredEnv: e.requiredEnv,
    notes: e.notes,
    enabled: overrides.enabled,
  };
}

const ADD_OPTS = {
  transport: { type: "string", short: "t" },
  command: { type: "string" },
  args: { type: "string", multiple: true },
  url: { type: "string" },
  env: { type: "string", multiple: true },
  "plain-env": { type: "string", multiple: true },
  header: { type: "string", multiple: true },
  authType: { type: "string" },
  disable: { type: "boolean" },
} as const;

export async function cmdAdd(rest: string[], deps: { secretStore?: SecretStore } = {}): Promise<void> {
  // Support the `--` convention so dash-leading args (e.g. npx's `-y`) pass
  // unambiguously: `nexus add x --transport stdio --command npx -- -y @pkg`.
  // Everything after `--` is appended verbatim to the server's args.
  const ddIdx = rest.indexOf("--");
  const pre = ddIdx >= 0 ? rest.slice(0, ddIdx) : rest;
  const trailingArgs = ddIdx >= 0 ? rest.slice(ddIdx + 1) : [];

  const { values, positionals } = parseArgs({
    args: pre,
    options: ADD_OPTS,
    allowPositionals: true,
  });

  const secretEnvMap = toRecord(values.env); // -> OS keychain
  const plainEnvMap = toRecord(values["plain-env"]); // -> plaintext config
  const headers = toRecord(values.header);
  const enabled = !values.disable;
  const target = positionals[0];

  let cfg: ParsedServerConfig;

  const catalogEntry = target ? await findCatalogEntry(target) : undefined;
  if (catalogEntry) {
    cfg = catalogEntryToConfig(catalogEntry, { headers, enabled });

    // requiredEnv: satisfied if provided via --env/--plain-env OR in process.env.
    const provided = { ...secretEnvMap, ...plainEnvMap };
    const missing = (cfg.requiredEnv ?? []).filter((r) => !(r in provided) && !(r in process.env));
    if (missing.length > 0) {
      throw new Error(
        `'${target}' requires: ${missing.join(", ")}.\n` +
          `Provide via --env NAME=value (stored in the keychain), or export them in your shell.\n` +
          (catalogEntry.underlyingService ? `Note: ${catalogEntry.underlyingService}\n` : ""),
      );
    }
    const shellOnly = (cfg.requiredEnv ?? []).filter((r) => !(r in provided) && r in process.env);
    if (shellOnly.length > 0) {
      console.error(
        `warning: ${shellOnly.join(", ")} taken from your shell env and NOT persisted.\n` +
          `         ensure they're exported when running 'nexus serve', or pass via --env.`,
      );
    }
    if (catalogEntry.underlyingService) console.error(`note: ${catalogEntry.underlyingService}`);
  } else {
    // Freeform install (PRD §11.2).
    if (!target) throw new Error("Usage: nexus add <name> --transport stdio --command ... | --transport streamable-http --url ...");
    const transport = values.transport as ServerConfig["transport"] | undefined;
    if (!transport) throw new Error("--transport is required (stdio | sse | streamable-http)");
    cfg = {
      name: target,
      transport,
      command: values.command,
      args: values.args,
      url: values.url,
      env: {},
      secretEnv: [],
      headers,
      authType: (values.authType as ParsedServerConfig["authType"]) ?? "none",
      enabled,
    };
  }

  if (trailingArgs.length > 0) {
    cfg.args = [...(cfg.args ?? []), ...trailingArgs];
  }

  // Env handling: --env values go to the keychain (secretEnv, never written to
  // config.json); --plain-env stays in plaintext config. If no keychain is
  // available, --env falls back to plaintext with a warning.
  const secretStore = deps.secretStore ?? getDefaultSecretStore();
  cfg.env = { ...plainEnvMap };
  cfg.secretEnv = [];
  if (Object.keys(secretEnvMap).length > 0) {
    if (secretStore) {
      for (const [k, v] of Object.entries(secretEnvMap)) await secretStore.set(cfg.name, k, v);
      cfg.secretEnv = Object.keys(secretEnvMap);
    } else {
      console.error("warning: OS keychain unavailable; --env values stored in plaintext config");
      cfg.env = { ...plainEnvMap, ...secretEnvMap };
    }
  }

  const config = await loadConfig();
  await upsertServer(config, cfg);
  const where = cfg.secretEnv.length ? `keychain (${cfg.secretEnv.join(", ")})` : "config";
  console.log(`Added server '${cfg.name}' [${cfg.transport}]; secrets in ${where}. Run 'nexus list-tools' to verify.`);
}
