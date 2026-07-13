import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Embedder } from "./embeddings.js";
import type { SQLiteStore, StoredEntry } from "./store.js";
import { argsFingerprint, argsToText, contributingFingerprint } from "./fingerprint.js";
import { classifySimilarity, isExpired, DEFAULT_TTL_MS } from "./policy.js";
import type { TtlResolver } from "./ttl.js";
import type { Verifier } from "./verifier.js";
import { logger } from "../logging.js";
import type { RouteEntry } from "../types.js";

export interface MemoryCacheOptions {
  store: SQLiteStore;
  /** Embeddings provider. Absent or failing → exact-match only (graceful). */
  embedder?: Embedder;
  /** Per-tool TTL resolver (entity-snapshot policy). Wins over ttlMs. */
  ttlFor?: TtlResolver;
  /** Flat per-entry TTL in ms (Infinity = never expire). Fallback if no ttlFor. */
  ttlMs?: number;
  /** How many nearest neighbors to consider for semantic lookup. */
  searchK?: number;
  /** Decides gray-zone (~0.85–0.92) matches. Absent → gray falls back to refetch. */
  verifier?: Verifier;
}

export type CacheSource = "hit-exact" | "hit-semantic" | "hit-verified" | "miss" | "non-cacheable";

export interface CallOutcome {
  result: CallToolResult;
  source: CacheSource;
}

/**
 * The memory layer for the gateway. Wraps a tool call with a cache lookup:
 *
 *   non-cacheable tool        → forward every time (no caching)
 *   exact args-fingerprint hit → serve cached (no forward, no embedding)
 *   semantic NN in "hit" band  → serve cached
 *   semantic NN in "gray" band → (verify is a stubbed seam) → forward + store
 *   otherwise                  → forward; store non-error results
 *
 * Exact-key is the workhorse: structurally distinct args (env:"staging" vs
 * "production") are different entries, so the similarity layer only ever
 * matches paraphrased/normalized-equivalent args.
 */
export class MemoryCache {
  constructor(private opts: MemoryCacheOptions) {}

  /** The underlying store (meta-tools read memory through this). */
  get store(): SQLiteStore {
    return this.opts.store;
  }

  async callWithMemory(
    tool: string,
    route: RouteEntry,
    args: unknown,
    forward: () => Promise<CallToolResult>,
  ): Promise<CallOutcome> {
    if (!route.cacheable) {
      return { result: await forward(), source: "non-cacheable" };
    }

    const fp = argsFingerprint(args);
    const now = Date.now();

    // 1) Exact key lookup — fast path, no embedding needed.
    const exact = this.opts.store.getByFingerprint(tool, fp);
    if (exact) {
      if (isExpired(exact.expiresAt, now)) {
        this.opts.store.deleteById(exact.id);
      } else {
        return { result: this.deserialize(exact), source: "hit-exact" };
      }
    }

    // 2) Semantic nearest-neighbor lookup (skipped if no embedder / embed fails;
    //    exact-match above still works, so memory degrades gracefully).
    const text = argsToText(tool, args);
    let vec: Float32Array | null = null;
    if (this.opts.embedder) {
      try {
        const embeddings = await this.opts.embedder.embed([text]);
        vec = embeddings[0] ?? null;
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "embedding failed; semantic match skipped");
      }
    }
    if (vec) {
      const hits = this.opts.store.searchByEmbedding(vec, this.opts.searchK ?? 5);
      const best = hits
        .filter((h) => h.entry.tool === tool && !isExpired(h.entry.expiresAt, now))
        .sort((a, b) => b.similarity - a.similarity)[0];

      if (best && classifySimilarity(best.similarity) === "hit") {
        return { result: this.deserialize(best.entry), source: "hit-semantic" };
      }
      if (best && classifySimilarity(best.similarity) === "gray") {
        if (this.opts.verifier) {
          const verdict = await this.opts.verifier.verify({
            tool,
            args,
            candidateArgsText: best.entry.argsText,
            candidateResultJson: best.entry.resultJson,
            similarity: best.similarity,
          });
          if (verdict.accept) {
            logger.debug({ tool, sim: best.similarity, reason: verdict.reason }, "gray-zone verified → cached");
            return { result: this.deserialize(best.entry), source: "hit-verified" };
          }
          logger.debug({ tool, sim: best.similarity, reason: verdict.reason }, "gray-zone rejected → refetch");
        } else {
          logger.debug({ tool, sim: best.similarity }, "gray-zone → refetch (no verifier)");
        }
      }
    }

    // 3) Miss: forward, then cache non-error results.
    const result = await forward();
    if (!result.isError) {
      const ttl = this.opts.ttlFor ? this.opts.ttlFor(tool) : (this.opts.ttlMs ?? DEFAULT_TTL_MS);
      this.opts.store.put({
        tool,
        argsFingerprint: fp,
        argsText: text,
        resultJson: JSON.stringify(result),
        contributing: contributingFingerprint([route.serverName]),
        servers: [route.serverName],
        embedding: vec,
        createdAt: now,
        expiresAt: ttl === Infinity ? null : now + ttl,
      });
    }
    return { result, source: "miss" };
  }

  /** Drop cache entries contributed to by `serverName` (on server removal). */
  invalidateServer(serverName: string): number {
    return this.opts.store.invalidateServer(serverName);
  }

  private deserialize(entry: StoredEntry): CallToolResult {
    return JSON.parse(entry.resultJson) as CallToolResult;
  }
}
