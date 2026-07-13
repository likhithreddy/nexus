import { z } from "zod";
import type { ServerConfig, TransportType, AuthType } from "../types.js";

/**
 * Slug used as a tool namespace prefix. No dots allowed — a dot is the
 * separator between server name and tool name, so the prefix must be dot-free.
 */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const ServerConfigSchema = z.object({
  name: z
    .string()
    .regex(SLUG_REGEX, "name must be lowercase, start alphanumeric, and only contain [a-z0-9-]"),
  transport: z.enum(["stdio", "sse", "streamable-http"]),
  enabled: z.boolean().default(true),

  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  secretEnv: z.array(z.string()).optional(),
  cwd: z.string().optional(),

  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),

  authType: z.enum(["none", "api_key", "oauth"]).default("none"),
  requiredEnv: z.array(z.string()).optional(),
  notes: z.string().optional(),
  addedAt: z.string().optional(),
});

export const NexusConfigSchema = z.object({
  version: z.literal(1).default(1),
  servers: z.array(ServerConfigSchema).default([]),
  /**
   * Per-tool cache TTL overrides, keyed by namespaced tool name (`<server>.<tool>`)
   * with `<server>.*` and `*` wildcards. Values are durations ("30s","5m","12h",
   * "1d", ms number) or "never". See src/memory/ttl.ts.
   */
  ttl: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  /** Opt-in: infer short TTLs for volatile-looking tools (status/logs/now/…). */
  ttlHeuristics: z.boolean().optional(),
  /** TTL (ms or duration string) applied by the heuristics. Default "5m". */
  heuristicTtlMs: z.union([z.string(), z.number()]).optional(),
});

export const CatalogEntrySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  transport: z.enum(["stdio", "sse", "streamable-http"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  requiredEnv: z.array(z.string()).default([]),
  authType: z.enum(["none", "api_key", "oauth"]).default("none"),
  underlyingService: z.string().optional(),
  notes: z.string().optional(),
});

export type ParsedServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Transport-conditional validation that zod can't express cleanly. Returns a
 * list of human-readable error strings (empty = valid).
 */
export function validateServerConfig(c: {
  transport: TransportType;
  command?: string;
  url?: string;
  authType?: AuthType;
  requiredEnv?: string[];
  env?: Record<string, string>;
}): string[] {
  const errors: string[] = [];
  if (c.transport === "stdio") {
    if (!c.command) errors.push("stdio transport requires a 'command'");
  } else {
    if (!c.url) errors.push(`${c.transport} transport requires a 'url'`);
  }
  if (c.authType === "oauth") {
    errors.push(
      "oauth auth is not yet supported (separate workstream, PRD §12); use api_key/none for now",
    );
  }
  return errors;
}
