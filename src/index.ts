/**
 * Nexus public API — for programmatic use (the future embeddable shape).
 */
export { MCPRegistry } from "./aggregation/registry.js";
export { ConnectionManager } from "./aggregation/connectionManager.js";
export { createGateway } from "./server/gateway.js";
export {
  normalizeServerName,
  namespaceToolName,
  parseNamespacedToolName,
  isCacheableTool,
} from "./aggregation/namespace.js";
export { buildNamespacedEntries, mergeEntries } from "./aggregation/manifest.js";
export type {
  ServerConfig,
  CatalogEntry,
  NamespacedToolEntry,
  RouteEntry,
  MergedManifest,
  TransportType,
  AuthType,
} from "./types.js";
