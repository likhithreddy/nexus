/**
 * Per-tool TTL policy — the "entity snapshot" half of the PRD (§4.2). Some
 * tools return volatile data (a ticket status, a build state) that should be
 * re-fetched after a TTL, while stable tools (a doc, a repo's creation date)
 * can be cached forever. Defaults to Infinity (stable); users override per tool
 * in config.
 *
 * Overrides are keyed by the namespaced tool name (`<server>.<tool>`), with two
 * wildcard forms: `<server>.*` (all tools from a server) and `*` (everything).
 * Precedence: exact > server-wildcard > global-wildcard > default (Infinity).
 */
const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a duration: number = ms; "30s"/"5m"/"12h"/"1d"; "never"/"Infinity". */
export function parseDuration(v: string | number): number {
  if (typeof v === "number") return v;
  const s = v.trim().toLowerCase();
  if (s === "" || s === "infinity" || s === "never") return Infinity;
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(s);
  if (!m) throw new Error(`invalid TTL duration: ${JSON.stringify(v)}`);
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  return n * UNITS[unit]!;
}

export type TtlResolver = (namespacedTool: string) => number;

export function buildTtlResolver(overrides: Record<string, string | number>): TtlResolver {
  const compiled = Object.entries(overrides).map(([pattern, val]) => ({
    pattern,
    ttlMs: parseDuration(val),
  }));

  return (namespacedTool: string): number => {
    const exact = compiled.find((c) => c.pattern === namespacedTool);
    if (exact) return exact.ttlMs;

    const server = namespacedTool.split(".")[0] ?? namespacedTool;
    const serverStar = compiled.find((c) => c.pattern === `${server}.*`);
    if (serverStar) return serverStar.ttlMs;

    const globalStar = compiled.find((c) => c.pattern === "*");
    if (globalStar) return globalStar.ttlMs;

    return Infinity;
  };
}

/**
 * Heuristic time-sensitivity (opt-in). When a tool has no explicit TTL, infer a
 * short TTL from its name so volatile tools (status/current/now/logs/…) refresh
 * automatically. Conservative and always overridable by explicit config.
 *
 * Off by default — enable via `ttlHeuristics: true` in config.
 */
export const DEFAULT_HEURISTIC_TTL_MS = 5 * 60_000; // 5 minutes

const VOLATILE_KEYWORDS = [
  "status", "current", "now", "latest", "today", "recent", "active", "pending",
  "running", "health", "log", "metric", "notification", "inbox", "build", "deploy",
  "queue", "alert", "heartbeat", "uptime", "ci",
];

export function looksVolatile(namespacedTool: string): boolean {
  const t = namespacedTool.toLowerCase();
  return VOLATILE_KEYWORDS.some((kw) => t.includes(kw));
}

/**
 * Compose explicit config + opt-in heuristics. Explicit always wins; heuristics
 * only apply when enabled AND the tool looks volatile AND there's no explicit
 * rule; otherwise Infinity.
 */
export function composeTtlResolver(opts: {
  explicit?: TtlResolver;
  heuristics?: boolean;
  heuristicTtlMs?: number;
}): TtlResolver {
  const hMs = opts.heuristicTtlMs ?? DEFAULT_HEURISTIC_TTL_MS;
  return (namespacedTool: string): number => {
    const explicit = opts.explicit?.(namespacedTool) ?? Infinity;
    if (explicit !== Infinity) return explicit;
    if (opts.heuristics && looksVolatile(namespacedTool)) return hMs;
    return Infinity;
  };
}
