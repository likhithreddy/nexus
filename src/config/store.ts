import fs from "node:fs/promises";
import path from "node:path";
import { getConfigPath, getNexusHome } from "./paths.js";
import { NexusConfigSchema, type ParsedServerConfig } from "./schema.js";
import { validateServerConfig } from "./schema.js";
import { logger } from "../logging.js";

export interface NexusConfig {
  version: number;
  servers: ParsedServerConfig[];
  ttl?: Record<string, string | number>;
  ttlHeuristics?: boolean;
  heuristicTtlMs?: string | number;
}

async function ensureHome(): Promise<void> {
  await fs.mkdir(getNexusHome(), { recursive: true });
}

/** Load config, creating an empty one if absent. Throws on malformed JSON. */
export async function loadConfig(): Promise<NexusConfig> {
  const cfgPath = getConfigPath();
  try {
    const raw = await fs.readFile(cfgPath, "utf8");
    const parsed = NexusConfigSchema.parse(JSON.parse(raw));
    return parsed as NexusConfig;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return { version: 1, servers: [] };
    }
    // Re-surface schema/parse errors loudly — a corrupt config is a real problem.
    throw err;
  }
}

export async function saveConfig(config: NexusConfig): Promise<void> {
  await ensureHome();
  const cfgPath = getConfigPath();
  await fs.writeFile(cfgPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function findServer(config: NexusConfig, name: string): ParsedServerConfig | undefined {
  return config.servers.find((s) => s.name === name);
}

/** Add or replace a server entry; validates before writing. */
export async function upsertServer(
  config: NexusConfig,
  server: ParsedServerConfig,
): Promise<NexusConfig> {
  const problems = validateServerConfig(server);
  if (problems.length > 0) {
    throw new Error(`Invalid server config for "${server.name}":\n  - ${problems.join("\n  - ")}`);
  }
  const entry: ParsedServerConfig = { ...server, addedAt: server.addedAt ?? new Date().toISOString() };
  const idx = config.servers.findIndex((s) => s.name === entry.name);
  const servers = [...config.servers];
  if (idx >= 0) servers[idx] = entry;
  else servers.push(entry);
  const next = { ...config, servers };
  await saveConfig(next);
  logger.debug({ server: entry.name, path: path.join(getNexusHome(), "config.json") }, "server config saved");
  return next;
}

export async function removeServer(config: NexusConfig, name: string): Promise<NexusConfig> {
  const servers = config.servers.filter((s) => s.name !== name);
  const next = { ...config, servers };
  await saveConfig(next);
  return next;
}
