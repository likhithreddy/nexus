import os from "node:os";
import path from "node:path";

/**
 * Where Nexus stores local runtime data: config.json, (later) memory db.
 * Overridable via NEXUS_HOME for tests / alternate profiles.
 */
export function getNexusHome(): string {
  return process.env.NEXUS_HOME ?? path.join(os.homedir(), ".nexus");
}

export function getConfigPath(): string {
  return path.join(getNexusHome(), "config.json");
}

export function getCatalogUserPath(): string {
  return path.join(getNexusHome(), "catalog.json");
}
