/**
 * Tiered cache-hit policy. Cosine similarity bands:
 *   - hit:  >= HIT_THRESHOLD       → serve cached directly
 *   - gray: [GRAY_LOW, HIT_THRESHOLD) → verify (harness sampling) ; accept serves, reject refetches
 *   - miss: < GRAY_LOW             → forward + store
 *
 * Defaults (0.85 / 0.70) are tuned for the local `bge-small-en-v1.5` embedder,
 * whose paraphrase pairs land ~0.7–0.8 and unrelated pairs ~0.3. Override via
 * env `NEXUS_HIT_THRESHOLD` / `NEXUS_GRAY_LOW` (e.g. raise to 0.92/0.85 for
 * OpenAI embeddings).
 *
 * NOTE: the dominant mechanism is the *exact* args fingerprint (e.g.
 * env:"staging" vs "production" are separate entries), so the staging/production
 * trap is avoided before similarity is even consulted.
 */
export const HIT_THRESHOLD = Number(process.env.NEXUS_HIT_THRESHOLD ?? 0.85);
export const GRAY_LOW = Number(process.env.NEXUS_GRAY_LOW ?? 0.70);

export type SimilarityBand = "hit" | "gray" | "miss";

export function classifySimilarity(similarity: number): SimilarityBand {
  if (similarity >= HIT_THRESHOLD) return "hit";
  if (similarity >= GRAY_LOW) return "gray";
  return "miss";
}

/**
 * Default per-entry TTL. cacheable tools default to never expiring (the "stable"
 * memory type). Override per tool via config `ttl`. Infinity = never expire.
 */
export const DEFAULT_TTL_MS = Infinity;

export function isExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && expiresAt <= now;
}
