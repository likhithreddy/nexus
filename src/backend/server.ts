import http from "node:http";
import type { Embedder } from "../memory/embeddings.js";
import { SQLiteStore } from "../memory/store.js";
import { MCPRegistry, UnknownToolError, ServerUnavailableError } from "../aggregation/registry.js";
import { ConnectionManager } from "../aggregation/connectionManager.js";
import { LocalEmbedder } from "../memory/embeddings.js";
import { getDefaultSecretStore } from "../secrets/store.js";
import { loadConfig } from "../config/store.js";
import { getDbPath } from "../config/paths.js";
import { composeTtlResolver, buildTtlResolver } from "../memory/ttl.js";
import { QaCache } from "./qaCache.js";
import { VERSION } from "../version.js";
import { logger } from "../logging.js";
import type { ListeningEvent } from "./types.js";

export interface BackendOptions {
  port?: number;
  host?: string;
  token?: string;
}

/**
 * Start the Nexus backend HTTP server. Exposes a REST API for the VS Code
 * extension: tool list/call, Q&A cache lookup/store, stats. All node:sqlite /
 * transformers.js work happens here (the extension host can't use them).
 *
 * On listen, prints one JSON line to stdout: {"event":"listening","port":N}
 * (the extension parses this to discover the port).
 */
export async function startBackend(opts: BackendOptions = {}): Promise<{
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}> {
  const host = opts.host ?? "127.0.0.1";

  // --- Initialize (mirrors cmdServe wiring) ---
  const embedder: Embedder = new LocalEmbedder();
  logger.info("backend: warming up embedder…");
  try {
    await embedder.embed(["warmup"]);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "backend: embedder warmup failed (exact-match only)");
  }

  const store = new SQLiteStore(getDbPath(), embedder.dimension);
  const secretStore = getDefaultSecretStore();
  const registry = new MCPRegistry(new ConnectionManager({ secretStore }));

  const config = await loadConfig();
  const { ok, failed } = await registry.reloadAll(config.servers);
  logger.info({ connected: ok.length, failed }, "backend: registry loaded");

  const ttlFor = composeTtlResolver({
    explicit: buildTtlResolver(config.ttl ?? {}),
    heuristics: config.ttlHeuristics === true,
    heuristicTtlMs: config.heuristicTtlMs ? Number(config.heuristicTtlMs) : undefined,
  });

  const qa = new QaCache({ store, embedder });

  // --- HTTP server ---
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname;
      const method = req.method ?? "GET";

      // Auth
      if (opts.token) {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${opts.token}`) {
          return json(res, 401, { error: "unauthorized" });
        }
      }

      // GET /health
      if (method === "GET" && path === "/health") {
        return json(res, 200, {
          ok: true,
          version: VERSION,
          tools: registry.listTools().length,
          servers: registry.serverNames().length,
        });
      }

      // GET /tools
      if (method === "GET" && path === "/tools") {
        return json(res, 200, registry.listTools());
      }

      // POST /tools/call
      if (method === "POST" && path === "/tools/call") {
        const body = await readBody(req);
        const { name, args } = JSON.parse(body) as { name: string; args?: unknown };
        try {
          const result = await registry.callTool(name, args);
          return json(res, 200, result);
        } catch (err) {
          if (err instanceof UnknownToolError) return json(res, 404, { error: err.message });
          if (err instanceof ServerUnavailableError) return json(res, 503, { error: err.message });
          throw err;
        }
      }

      // POST /qa/lookup
      if (method === "POST" && path === "/qa/lookup") {
        const body = await readBody(req);
        const { question, contextSignature } = JSON.parse(body) as { question: string; contextSignature?: string };
        const result = await qa.lookup(question, contextSignature ?? "");
        return json(res, 200, result);
      }

      // POST /qa/store
      if (method === "POST" && path === "/qa/store") {
        const body = await readBody(req);
        const reqData = JSON.parse(body);
        const result = await qa.store(reqData, ttlFor);
        return json(res, 200, result);
      }

      // GET /stats
      if (method === "GET" && path === "/stats") {
        const s = store.stats();
        const qaS = store.qaStats();
        return json(res, 200, { ...s, qa: qaS });
      }

      // POST /reload
      if (method === "POST" && path === "/reload") {
        const cfg = await loadConfig();
        const r = await registry.reloadAll(cfg.servers);
        return json(res, 200, r);
      }

      return json(res, 404, { error: `not found: ${method} ${path}` });
    } catch (err) {
      logger.error({ err: (err as Error).message }, "backend request error");
      return json(res, 500, { error: (err as Error).message });
    }
  });

  // --- Listen ---
  await new Promise<void>((resolve) => {
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
      const event: ListeningEvent = { event: "listening", port, host };
      if (opts.token) event.token = opts.token;
      process.stdout.write(JSON.stringify(event) + "\n");
      logger.info({ port, host }, "backend listening");
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);

  const close = async (): Promise<void> => {
    await registry.closeAll();
    store.close();
    server.close();
  };

  return { server, port, close };
}

// --- helpers ---

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
