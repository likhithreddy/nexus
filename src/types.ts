import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Transports Nexus can use to reach a child MCP server. */
export type TransportType = "stdio" | "sse" | "streamable-http";

/** How a server authenticates. OAuth is a separate, heavier workstream (PRD §12). */
export type AuthType = "none" | "api_key" | "oauth";

/**
 * A single connected child MCP server, as persisted in the user's config.
 *
 * The `name` doubles as the tool namespace prefix (e.g. name "jira" → tool
 * "jira.get_issue"), so it must be a slug with no dots (see schema.ts).
 */
export interface ServerConfig {
  name: string;
  transport: TransportType;
  enabled?: boolean;

  // --- stdio transport ---
  command?: string;
  args?: string[];
  /** Plaintext env values injected at spawn time (non-secret overrides). */
  env?: Record<string, string>;
  /** Env var names whose values are stored encrypted in the OS keychain. */
  secretEnv?: string[];
  cwd?: string;

  // --- remote (sse / streamable-http) transport ---
  url?: string;
  headers?: Record<string, string>;

  // --- meta ---
  authType?: AuthType;
  /** Env var names the server requires; surfaced during `nexus add`. */
  requiredEnv?: string[];
  notes?: string;
  addedAt?: string;
}

/**
 * A tool entry after namespacing. `tool` is what gets exposed to downstream
 * clients (its `name` is rewritten to "<server>.<original>"); the routing +
 * cacheability metadata stays on the Nexus side via the registry's route table.
 */
export interface NamespacedToolEntry {
  tool: Tool;
  serverName: string;
  originalName: string;
  namespacedName: string;
  /**
   * Derived cacheability seam for the memory layer: a read-only or idempotent
   * tool is safe to cache; destructive tools never are. See namespace.ts.
   */
  cacheable: boolean;
}

/** Routing info the registry keeps per exposed (namespaced) tool name. */
export interface RouteEntry {
  serverName: string;
  originalName: string;
  cacheable: boolean;
}

/** Result of merging all servers' tools into one manifest. */
export interface MergedManifest {
  tools: Tool[];
  routes: Map<string, RouteEntry>;
  /** Namespaced names that collided across servers and were de-duped (keep-first). */
  duplicates: string[];
}

/** A curated catalog install spec (PRD §11.1). */
export interface CatalogEntry {
  name: string;
  description?: string;
  transport: TransportType;
  // stdio
  command?: string;
  args?: string[];
  // remote
  url?: string;
  headers?: Record<string, string>;
  requiredEnv?: string[];
  authType?: AuthType;
  /** "free server, paid underlying service" distinction (PRD §11.1). */
  underlyingService?: string;
  notes?: string;
}
