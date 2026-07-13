import { createHash } from "node:crypto";

/**
 * Canonicalize a value to a stable JSON string: object keys sorted recursively,
 * so {a:1,b:2} and {b:2,a:1} produce the same fingerprint. Arrays preserve order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** sha256 of the canonical args — the exact-match cache key. */
export function argsFingerprint(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args ?? null)).digest("hex");
}

/**
 * The text we embed for semantic matching: the namespaced tool name plus the
 * canonical args. Structurally distinct args (e.g. env:"staging" vs "production")
 * have different fingerprints AND different embedded text, so they never collide.
 */
export function argsToText(tool: string, args: unknown): string {
  return `${tool}\n${canonicalJson(args ?? null)}`;
}

/** Fingerprint of the contributing server set, for config-change invalidation. */
export function contributingFingerprint(servers: string[]): string {
  return createHash("sha256").update([...servers].sort().join("\n")).digest("hex");
}
