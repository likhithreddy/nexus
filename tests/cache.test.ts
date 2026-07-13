import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SQLiteStore } from "../src/memory/store.js";
import { MemoryCache } from "../src/memory/cache.js";
import { argsToText } from "../src/memory/fingerprint.js";
import type { Embedder } from "../src/memory/embeddings.js";
import type { Verifier, VerifyResult } from "../src/memory/verifier.js";
import type { RouteEntry } from "../src/types.js";

const DIM = 4;
const text = (s: string) => ({ type: "text" as const, text: s });
const ok = (s: string): CallToolResult => ({ content: [text(s)] });
const cacheable = (name = "srv.echo"): RouteEntry => ({ serverName: "srv", originalName: name, cacheable: true });
const nonCacheable = (): RouteEntry => ({ serverName: "srv", originalName: "echo", cacheable: false });

/** Embedder scripted by exact argsToText string, so the test controls similarity. */
class ScriptedEmbedder implements Embedder {
  readonly dimension = DIM;
  constructor(private map: Record<string, Float32Array>) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    const zero = () => {
      const v = new Float32Array(DIM);
      v[0] = 0.01;
      return v;
    };
    return texts.map((t) => this.map[t] ?? zero());
  }
}
/** Verifier returning a fixed decision, to exercise the gray-zone wiring. */
class ScriptedVerifier implements Verifier {
  constructor(private decision: boolean) {}
  async verify(): Promise<VerifyResult> {
    return { accept: this.decision, reason: "scripted" };
  }
}

const unit = (...xs: number[]) => {
  const v = Float32Array.from(xs);
  const n = Math.sqrt(xs.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n) as Float32Array;
};

let dir: string;
let store: SQLiteStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-cache-"));
  store = new SQLiteStore(path.join(dir, "memory.db"), DIM);
});
afterEach(async () => {
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("MemoryCache", () => {
  it("serves exact repeats from cache without forwarding", async () => {
    const cache = new MemoryCache({ store, embedder: new ScriptedEmbedder({}) });
    let calls = 0;
    const fwd = async (): Promise<CallToolResult> => { calls++; return ok("fresh"); };

    const a = await cache.callWithMemory("srv.echo", cacheable(), { q: "x" }, fwd);
    expect(a.source).toBe("miss");
    expect(calls).toBe(1);

    const b = await cache.callWithMemory("srv.echo", cacheable(), { q: "x" }, fwd);
    expect(b.source).toBe("hit-exact");
    expect(calls).toBe(1); // not forwarded
    expect((b.result.content[0] as { text: string }).text).toBe("fresh");
  });

  it("forwards every time for non-cacheable tools", async () => {
    const cache = new MemoryCache({ store, embedder: new ScriptedEmbedder({}) });
    let calls = 0;
    const fwd = async (): Promise<CallToolResult> => { calls++; return ok(`${calls}`); };
    await cache.callWithMemory("srv.echo", nonCacheable(), { q: "x" }, fwd);
    await cache.callWithMemory("srv.echo", nonCacheable(), { q: "x" }, fwd);
    expect(calls).toBe(2);
    expect(store.stats().entries).toBe(0);
  });

  it("works with no embedder (exact-match only, semantic skipped)", async () => {
    const cache = new MemoryCache({ store }); // no embedder → graceful
    let calls = 0;
    const fwd = async (): Promise<CallToolResult> => { calls++; return ok("v"); };
    const a = await cache.callWithMemory("srv.echo", cacheable(), { q: "x" }, fwd);
    expect(a.source).toBe("miss");
    const b = await cache.callWithMemory("srv.echo", cacheable(), { q: "x" }, fwd);
    expect(b.source).toBe("hit-exact");
    expect(calls).toBe(1);
  });

  it("does not store error results", async () => {
    const cache = new MemoryCache({ store, embedder: new ScriptedEmbedder({}) });
    await cache.callWithMemory("srv.echo", cacheable(), { q: "bad" }, async () => ({
      isError: true,
      content: [text("nope")],
    }));
    expect(store.stats().entries).toBe(0);

    await cache.callWithMemory("srv.echo", cacheable(), { q: "good" }, async () => ok("yep"));
    expect(store.stats().entries).toBe(1);
  });

  it("serves a semantic hit for different args with the same embedding", async () => {
    const va = unit(1, 0, 0, 0);
    // Two distinct args texts map to the SAME vector → similarity 1.0 (hit band),
    // but their fingerprints differ → exact lookup misses, forcing the semantic path.
    const map: Record<string, Float32Array> = {
      [argsToText("srv.echo", { q: "alpha" })]: va,
      [argsToText("srv.echo", { q: "beta" })]: va,
    };
    const cache = new MemoryCache({ store, embedder: new ScriptedEmbedder(map) });
    let calls = 0;
    const fwd = async (): Promise<CallToolResult> => { calls++; return ok("answer"); };

    const a = await cache.callWithMemory("srv.echo", cacheable(), { q: "alpha" }, fwd);
    expect(a.source).toBe("miss");
    expect(calls).toBe(1);

    const b = await cache.callWithMemory("srv.echo", cacheable(), { q: "beta" }, fwd);
    expect(b.source).toBe("hit-semantic");
    expect(calls).toBe(1); // served from memory, not forwarded
  });

  it("refetches after a per-tool TTL expires", async () => {
    const cache = new MemoryCache({
      store,
      embedder: new ScriptedEmbedder({}),
      ttlFor: () => 1, // 1ms TTL
    });
    let calls = 0;
    const fwd = async (): Promise<CallToolResult> => { calls++; return ok(`n${calls}`); };

    const a = await cache.callWithMemory("srv.echo", cacheable(), { q: "x" }, fwd);
    expect(a.source).toBe("miss");
    expect(calls).toBe(1);

    await new Promise((r) => setTimeout(r, 15)); // past the TTL

    const b = await cache.callWithMemory("srv.echo", cacheable(), { q: "x" }, fwd);
    expect(b.source).toBe("miss"); // expired entry dropped → refetched
    expect(calls).toBe(2);
  });

  it("gray-zone: verifier accept serves cached, no verifier refetches", async () => {
    // Two distinct args map to vectors at cosine ~0.9 → gray band [0.85, 0.92).
    const map: Record<string, Float32Array> = {
      [argsToText("srv.echo", { q: "alpha" })]: unit(1, 0, 0, 0),
      [argsToText("srv.echo", { q: "beta" })]: unit(0.78, Math.sqrt(1 - 0.78 * 0.78), 0, 0),
    };
    const cache = new MemoryCache({
      store,
      embedder: new ScriptedEmbedder(map),
      verifier: new ScriptedVerifier(true),
    });
    let calls = 0;
    const fwd = async (): Promise<CallToolResult> => { calls++; return ok("a"); };

    await cache.callWithMemory("srv.echo", cacheable(), { q: "alpha" }, fwd); // miss → store
    const out = await cache.callWithMemory("srv.echo", cacheable(), { q: "beta" }, fwd); // gray → verify
    expect(out.source).toBe("hit-verified");
    expect(calls).toBe(1); // verifier accepted → not forwarded
  });

  it("gray-zone: verifier reject refetches and stores", async () => {
    const map: Record<string, Float32Array> = {
      [argsToText("srv.echo", { q: "alpha" })]: unit(1, 0, 0, 0),
      [argsToText("srv.echo", { q: "beta" })]: unit(0.78, Math.sqrt(1 - 0.78 * 0.78), 0, 0),
    };
    const cache = new MemoryCache({
      store,
      embedder: new ScriptedEmbedder(map),
      verifier: new ScriptedVerifier(false),
    });
    let calls = 0;
    const fwd = async (): Promise<CallToolResult> => { calls++; return ok("a"); };

    await cache.callWithMemory("srv.echo", cacheable(), { q: "alpha" }, fwd);
    const out = await cache.callWithMemory("srv.echo", cacheable(), { q: "beta" }, fwd); // gray → reject
    expect(out.source).toBe("miss");
    expect(calls).toBe(2);
  });
});
