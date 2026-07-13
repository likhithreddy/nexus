import fs from "node:fs/promises";
import { getCatalogUserPath } from "./paths.js";
import { CatalogEntrySchema } from "./schema.js";
import type { CatalogEntry } from "../types.js";

// Curated catalog shipped with the package (PRD §11.1).
import bundledCatalog from "../../catalog/servers.json" with { type: "json" };

function parseCatalog(raw: unknown): CatalogEntry[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((e) => CatalogEntrySchema.parse(e) as CatalogEntry);
}

/** Bundled (curated) catalog entries. */
export function getBundledCatalog(): CatalogEntry[] {
  return parseCatalog(bundledCatalog);
}

/**
 * User overrides/extra catalog entries from ~/.nexus/catalog.json, if present.
 * Merged on top of the bundled catalog (user entries win on name collision).
 */
export async function getUserCatalog(): Promise<CatalogEntry[]> {
  try {
    const raw = await fs.readFile(getCatalogUserPath(), "utf8");
    return parseCatalog(JSON.parse(raw));
  } catch {
    return [];
  }
}

export async function getMergedCatalog(): Promise<CatalogEntry[]> {
  const bundled = getBundledCatalog();
  const user = await getUserCatalog();
  const byName = new Map<string, CatalogEntry>();
  for (const e of bundled) byName.set(e.name, e);
  for (const e of user) byName.set(e.name, e); // user wins
  return [...byName.values()];
}

export async function findCatalogEntry(name: string): Promise<CatalogEntry | undefined> {
  const merged = await getMergedCatalog();
  return merged.find((e) => e.name === name);
}
