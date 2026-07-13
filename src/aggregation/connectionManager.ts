import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerConfig } from "../types.js";
import type { SecretStore } from "../secrets/store.js";
import { resolveSecretEnv } from "../secrets/store.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import { logger } from "../logging.js";

/** A live child MCP connection. */
export interface ConnectedServer {
  config: ServerConfig;
  client: Client;
  /** Discovered (raw) tools; refetched on reload. */
  tools: import("@modelcontextprotocol/sdk/types.js").Tool[];
  /** Discovered (raw) resources (URIs unchanged). */
  resources: import("@modelcontextprotocol/sdk/types.js").Resource[];
  /** Discovered (raw) prompts (names unchanged). */
  prompts: import("@modelcontextprotocol/sdk/types.js").Prompt[];
}

const CONNECT_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Owns the lifecycle of child MCP connections: build the right transport per
 * config, run the MCP `initialize` handshake (via Client.connect), and tear
 * down cleanly. Does not do tool discovery — that lives in discovery.ts.
 */
export interface ConnectionManagerOptions {
  /**
   * Override transport creation. Defaults to the real per-transport builders.
   * Tests inject an in-memory transport here to exercise the full connect →
   * discover → forward pipeline without spawning child processes.
   */
  buildTransport?: (config: ServerConfig, secretEnv?: Record<string, string>) => Transport;
  /** Encrypted secret store; resolved per-server at connect time. */
  secretStore?: SecretStore;
}

export class ConnectionManager {
  private readonly buildTransportFn: (config: ServerConfig, secretEnv?: Record<string, string>) => Transport;
  private readonly secretStore?: SecretStore;

  constructor(opts: ConnectionManagerOptions = {}) {
    this.buildTransportFn = opts.buildTransport ?? this.buildTransport.bind(this);
    this.secretStore = opts.secretStore;
  }

  /** Build the real transport for the configured server, without connecting. */
  buildTransport(config: ServerConfig, secretEnv: Record<string, string> = {}): Transport {
    switch (config.transport) {
      case "stdio": {
        // Merge process.env so PATH/etc survive; layer the server's config env
        // and resolved secrets on top. Passing env replaces the spawn env
        // entirely. Cast: Node's ProcessEnv is Record<string, string | undefined>,
        // but spawn treats undefined entries as absent, which is what we want.
        const env = { ...process.env, ...config.env, ...secretEnv } as Record<string, string>;
        return new StdioClientTransport({
          command: config.command!,
          args: config.args,
          env,
          cwd: config.cwd,
          stderr: "pipe",
        });
      }
      case "streamable-http": {
        const url = new URL(config.url!);
        const opts = config.headers ? { requestInit: { headers: config.headers } } : undefined;
        return new StreamableHTTPClientTransport(url, opts);
      }
      case "sse": {
        const url = new URL(config.url!);
        const opts = config.headers ? { requestInit: { headers: config.headers } } : undefined;
        return new SSEClientTransport(url, opts);
      }
      default:
        throw new Error(`Unsupported transport: ${config.transport as string}`);
    }
  }

  /** Connect to a child server and return the live Client. */
  async connect(config: ServerConfig): Promise<Client> {
    // Resolve encrypted secrets (PRD §12) before building the transport.
    const secretEnv =
      this.secretStore && config.secretEnv?.length
        ? await resolveSecretEnv(this.secretStore, config.name, config.secretEnv)
        : {};
    const transport = this.buildTransportFn(config, secretEnv);

    // Surface child-process stderr as Nexus logs (stdio transport only).
    if (config.transport === "stdio") {
      const t = transport as StdioClientTransport;
      const childLog = logger.child({ server: config.name, src: "child-stderr" });
      t.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          const trimmed = line.trim();
          if (trimmed) childLog.info({ line: trimmed }, "child stderr");
        }
      });
    }

    const client = new Client(
      { name: `${PRODUCT_NAME}-client`, version: VERSION },
      { capabilities: {} },
    );
    client.onerror = (err) =>
      logger.error({ server: config.name, err: err.message }, "child client error");

    await withTimeout(
      client.connect(transport),
      CONNECT_TIMEOUT_MS,
      `connect ${config.name}`,
    );
    return client;
  }

  async disconnect(client: Client): Promise<void> {
    await client.close();
  }
}
