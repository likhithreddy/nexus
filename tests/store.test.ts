import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { SQLiteStore } from "../src/memory/store.js";
import { HashEmbedder } from "../src/memory/embeddings.js";

const DIM = 8;
let dir: string;
let store: SQLiteStore;
const emb = new HashEmbedder(DIM);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-store-"));
  store = new SQLiteStore(path.join(dir, "memory.db"), DIM);
});
afterEach(async () => {
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("SQLiteStore", () => {
  it("round-trips an entry via args fingerprint", async () => {
    const v = (await emb.embed(['srv.echo {"q":1}']))[0]!;
    const id = store.put({
      tool: "srv.echo",
      argsFingerprint: "fp1",
      argsText: "srv.echo {\"q\":1}",
      resultJson: JSON.stringify({ content: [{ type: "text", text: "hello" }] }),
      contributing: "c",
      servers: ["srv"],
      embedding: v,
      createdAt: 1,
      expiresAt: null,
    });
    expect(id).toBeGreaterThan(0);

    const got = store.getByFingerprint("srv.echo", "fp1");
    expect(got?.id).toBe(id);
    expect(got?.resultJson).toContain("hello");
  });

  it("finds the nearest neighbor by cosine similarity", async () => {
    const va = (await emb.embed(["alpha"]))[0]!;
    const vb = (await emb.embed(["beta"]))[0]!;
    store.put({
      tool: "t", argsFingerprint: "a", argsText: "alpha", resultJson: "{}",
      contributing: "c", servers: ["srv"], embedding: va, createdAt: 1, expiresAt: null,
    });
    store.put({
      tool: "t", argsFingerprint: "b", argsText: "beta", resultJson: "{}",
      contributing: "c", servers: ["srv"], embedding: vb, createdAt: 1, expiresAt: null,
    });

    // Querying with va's vector returns the alpha entry at similarity ~1.
    const hits = store.searchByEmbedding(va, 1);
    expect(hits[0]?.entry.argsFingerprint).toBe("a");
    expect(hits[0]?.similarity).toBeGreaterThan(0.999);
  });

  it("invalidates all entries for a given server", () => {
    store.put({ tool: "t", argsFingerprint: "a", argsText: "a", resultJson: "{}", contributing: "c", servers: ["jira"], embedding: null, createdAt: 1, expiresAt: null });
    store.put({ tool: "t", argsFingerprint: "b", argsText: "b", resultJson: "{}", contributing: "c", servers: ["github"], embedding: null, createdAt: 1, expiresAt: null });

    const removed = store.invalidateServer("jira");
    expect(removed).toBe(1);
    expect(store.getByFingerprint("t", "a")).toBeNull();
    expect(store.getByFingerprint("t", "b")).not.toBeNull();
  });

  it("deletes by id (including its vec row)", () => {
    const id = store.put({ tool: "t", argsFingerprint: "a", argsText: "a", resultJson: "{}", contributing: "c", servers: ["srv"], embedding: null, createdAt: 1, expiresAt: null });
    store.deleteById(id);
    expect(store.getByFingerprint("t", "a")).toBeNull();
    expect(store.stats().entries).toBe(0);
  });

  it("stats reports per-server counts", () => {
    store.put({ tool: "a.x", argsFingerprint: "1", argsText: "a", resultJson: "{}", contributing: "c", servers: ["a"], embedding: null, createdAt: 1, expiresAt: null });
    store.put({ tool: "a.y", argsFingerprint: "2", argsText: "a", resultJson: "{}", contributing: "c", servers: ["a"], embedding: null, createdAt: 1, expiresAt: null });
    store.put({ tool: "b.z", argsFingerprint: "3", argsText: "b", resultJson: "{}", contributing: "c", servers: ["b"], embedding: null, createdAt: 1, expiresAt: null });
    const s = store.stats();
    expect(s.entries).toBe(3);
    expect(s.byServer).toEqual({ a: 2, b: 1 });
  });

  it("listEntries filters by tool, server, and limit", () => {
    store.put({ tool: "a.x", argsFingerprint: "1", argsText: "a", resultJson: "{}", contributing: "c", servers: ["a"], embedding: null, createdAt: 1, expiresAt: null });
    store.put({ tool: "a.y", argsFingerprint: "2", argsText: "a", resultJson: "{}", contributing: "c", servers: ["a"], embedding: null, createdAt: 2, expiresAt: null });
    store.put({ tool: "b.z", argsFingerprint: "3", argsText: "b", resultJson: "{}", contributing: "c", servers: ["b"], embedding: null, createdAt: 3, expiresAt: null });

    expect(store.listEntries({ tool: "a.x" }).map((e) => e.tool)).toEqual(["a.x"]);
    expect(store.listEntries({ server: "b" }).map((e) => e.tool)).toEqual(["b.z"]);
    expect(store.listEntries({ limit: 2 }).length).toBe(2);
    // ordered by created_at DESC
    expect(store.listEntries({ server: "a" }).map((e) => e.tool)).toEqual(["a.y", "a.x"]);
  });

  it("forgetTool deletes all entries for a namespaced tool", () => {
    store.put({ tool: "a.x", argsFingerprint: "1", argsText: "a", resultJson: "{}", contributing: "c", servers: ["a"], embedding: null, createdAt: 1, expiresAt: null });
    store.put({ tool: "a.y", argsFingerprint: "2", argsText: "a", resultJson: "{}", contributing: "c", servers: ["a"], embedding: null, createdAt: 1, expiresAt: null });
    expect(store.forgetTool("a.x")).toBe(1);
    expect(store.getByFingerprint("a.x", "1")).toBeNull();
    expect(store.getByFingerprint("a.y", "2")).not.toBeNull();
  });
});
