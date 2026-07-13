import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  MergedManifest,
  NamespacedToolEntry,
  RouteEntry,
} from "../types.js";
import { isCacheableTool, namespaceToolName } from "./namespace.js";

/**
 * Rewrite one server's discovered tools into namespaced entries. The returned
 * `tool` object is what gets exposed downstream (name rewritten); routing and
 * cacheability metadata travel alongside for the registry's route table.
 *
 * Pure function — easy to unit-test without any live MCP connection.
 */
export function buildNamespacedEntries(
  serverName: string,
  tools: Tool[],
): NamespacedToolEntry[] {
  return tools.map((tool) => {
    const namespacedName = namespaceToolName(serverName, tool.name);
    return {
      tool: { ...tool, name: namespacedName },
      serverName,
      originalName: tool.name,
      namespacedName,
      cacheable: isCacheableTool(tool),
    };
  });
}

/**
 * Merge multiple servers' namespaced entries into one manifest + route table.
 * Keep-first on collision (shouldn't happen in practice since the server-name
 * prefix is unique, but a misconfigured catalog could produce it); collisions
 * are recorded for visibility.
 *
 * Pure function.
 */
export function mergeEntries(
  perServer: NamespacedToolEntry[][],
): MergedManifest {
  const tools: Tool[] = [];
  const routes = new Map<string, RouteEntry>();
  const duplicates: string[] = [];

  for (const entries of perServer) {
    for (const entry of entries) {
      if (routes.has(entry.namespacedName)) {
        duplicates.push(entry.namespacedName);
        continue;
      }
      routes.set(entry.namespacedName, {
        serverName: entry.serverName,
        originalName: entry.originalName,
        cacheable: entry.cacheable,
      });
      tools.push(entry.tool);
    }
  }

  return { tools, routes, duplicates };
}
