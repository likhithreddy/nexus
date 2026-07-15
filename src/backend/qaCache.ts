import { createHash } from "node:crypto";
import type { Embedder } from "../memory/embeddings.js";
import type { SQLiteStore } from "../memory/store.js";
import { classifySimilarity, isExpired } from "../memory/policy.js";
import type { TtlResolver } from "../memory/ttl.js";
import type { QaLookupResponse, QaStoreRequest, QaStoreResponse } from "./types.js";

export interface QaCacheDeps {
  store: SQLiteStore;
  embedder: Embedder;
  searchK?: number;
}

/**
 * Q&A cache facade: embeds the question, searches qa_cache by cosine similarity,
 * and serves the stored ANSWER on a hit. On a miss, the caller runs the LLM +
 * tools, then calls `store()` to cache the question→answer pair.
 *
 * This is the token-savings layer: a hit means 0 LLM tokens were spent.
 */
export class QaCache {
  constructor(private deps: QaCacheDeps) {}

  async lookup(question: string, contextSignature: string): Promise<QaLookupResponse> {
    const { store, embedder, searchK = 10 } = this.deps;
    const embeddings = await embedder.embed([question]);
    const vec = embeddings[0];
    if (!vec) return { hit: false };

    const hits = store.searchQaByEmbedding(vec, searchK, contextSignature);
    const now = Date.now();

    for (const hit of hits.sort((a, b) => b.similarity - a.similarity)) {
      if (isExpired(hit.entry.expiresAt, now)) continue;
      const band = classifySimilarity(hit.similarity);
      if (band === "hit") {
        store.incrementStat("qa_hits");
        store.incrementQaHit(hit.entry.id);
        return {
          hit: true,
          band,
          similarity: hit.similarity,
          entryId: hit.entry.id,
          answer: hit.entry.answer,
        };
      }
    }

    store.incrementStat("qa_misses");
    return { hit: false };
  }

  async store(req: QaStoreRequest, ttlFor: TtlResolver): Promise<QaStoreResponse> {
    const { store, embedder } = this.deps;
    const now = Date.now();

    // TTL = min of tool TTLs (or Infinity if no tools were used)
    const ttlMs = req.toolsUsed.length > 0
      ? Math.min(...req.toolsUsed.map((t) => ttlFor(t)))
      : Infinity;

    const embeddings = await embedder.embed([req.question]);
    const vec = embeddings[0] ?? null;
    const fingerprint = createHash("sha256").update(req.question).digest("hex");
    const tools = req.toolsUsed.map((t) => ({ tool: t, ttlMs: ttlFor(t) }));

    const entryId = store.putQa({
      embedding: vec,
      question: req.question,
      fingerprint,
      answer: req.answer,
      tools,
      contextSignature: req.contextSignature ?? "",
      createdAt: now,
      expiresAt: ttlMs === Infinity ? null : now + ttlMs,
    });

    store.incrementStat("qa_entries");
    return { entryId, ttlMs };
  }
}
