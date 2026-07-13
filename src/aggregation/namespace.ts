import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Separator between namespace (server name) and tool name. */
export const NAMESPACE_SEPARATOR = ".";

/**
 * Reduce an arbitrary user-provided name to a valid namespace slug.
 * Drops dots (they're reserved as the separator) and uppercases.
 */
export function normalizeServerName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function namespaceToolName(serverName: string, toolName: string): string {
  return `${serverName}${NAMESPACE_SEPARATOR}${toolName}`;
}

/**
 * Split a namespaced name back into server + original tool name.
 * Splits on the FIRST separator only, so tool names containing dots still route
 * correctly as long as the server prefix is dot-free (enforced by the slug rule).
 */
export function parseNamespacedToolName(
  name: string,
): { serverName: string; originalName: string } {
  const idx = name.indexOf(NAMESPACE_SEPARATOR);
  if (idx === -1) return { serverName: "", originalName: name };
  return { serverName: name.slice(0, idx), originalName: name.slice(idx + 1) };
}

/**
 * Decide whether a tool's result is safe to cache (the seam the memory layer
 * will consume). Derives from MCP tool annotations:
 *   - destructive tools are never cacheable
 *   - otherwise cacheable if the tool is read-only OR idempotent
 * Tools without annotations default to NOT cacheable (conservative — we'd
 * rather re-run an unannotated tool than serve a stale mutation).
 */
export function isCacheableTool(tool: Tool): boolean {
  const a = tool.annotations;
  if (!a) return false;
  if (a.destructiveHint === true) return false;
  return a.readOnlyHint === true || a.idempotentHint === true;
}
