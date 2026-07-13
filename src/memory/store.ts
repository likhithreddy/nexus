import "./suppress-sqlite-warning.js";
import { createRequire } from "node:module";
import { getLoadablePath } from "sqlite-vec";
import { logger } from "../logging.js";
import type * as NodeSQLite from "node:sqlite";

// node:sqlite is experimental and only resolvable via the `node:` prefix.
// Bundlers (esbuild/tsup) rewrite `node:sqlite` → `sqlite`, which Node then
// can't resolve (there's no bare `sqlite` core module). Load it through
// createRequire so the specifier survives bundling as a runtime string.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSQLite;
type DatabaseSync = InstanceType<typeof DatabaseSync>;

/** A stored cache entry (excluding the embedding, which lives in the vec table). */
export interface StoredEntry {
  id: number;
  tool: string;
  argsFingerprint: string;
  argsText: string;
  resultJson: string;
  contributing: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface StorePut {
  tool: string;
  argsFingerprint: string;
  argsText: string;
  resultJson: string;
  contributing: string;
  servers: string[];
  embedding: Float32Array | null;
  createdAt: number;
  expiresAt: number | null;
}

export interface SearchHit {
  entry: StoredEntry;
  similarity: number;
}

function toBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function rowToEntry(row: Record<string, unknown>): StoredEntry {
  return {
    id: Number(row["id"]),
    tool: String(row["tool"]),
    argsFingerprint: String(row["args_fingerprint"]),
    argsText: String(row["args_text"]),
    resultJson: String(row["result_json"]),
    contributing: String(row["contributing"]),
    createdAt: Number(row["created_at"]),
    expiresAt: row["expires_at"] == null ? null : Number(row["expires_at"]),
  };
}

/**
 * The unified memory store: a SQLite table for cache entries + a sqlite-vec
 * virtual table for nearest-neighbor search over embeddings. One physical store
 * serves both the "semantic answer cache" (stable, no expiry) and the "entity
 * snapshot" (volatile, TTL'd) cases — they differ only by TTL and keying.
 *
 * Uses node:sqlite (built-in, no native deps) + the prebuilt sqlite-vec
 * extension. Vectors bind as Float32 buffers; vec0 rowids must be BigInt.
 */
export class SQLiteStore {
  private db: DatabaseSync;
  readonly dimension: number;

  constructor(path: string, dimension: number) {
    this.dimension = dimension;
    this.db = new DatabaseSync(path, { allowExtension: true });
    this.db.enableLoadExtension(true);
    this.db.loadExtension(getLoadablePath());

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool TEXT NOT NULL,
        args_fingerprint TEXT NOT NULL,
        args_text TEXT NOT NULL,
        result_json TEXT NOT NULL,
        contributing TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tool_args ON tool_results(tool, args_fingerprint);
      CREATE TABLE IF NOT EXISTS tool_result_servers (
        entry_id INTEGER NOT NULL,
        server TEXT NOT NULL,
        PRIMARY KEY (entry_id, server)
      );
      CREATE INDEX IF NOT EXISTS idx_trs_server ON tool_result_servers(server);
    `);
    // Dimension is a validated integer from the embedder; safe to interpolate.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_tool_results USING vec0(embedding float[${Number(
        dimension,
      )}] distance_metric=cosine);`,
    );
  }

  /** Insert a cache entry; returns its id. */
  put(p: StorePut): number {
    const ins = this.db.prepare(
      `INSERT INTO tool_results (tool, args_fingerprint, args_text, result_json, contributing, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run(
      p.tool,
      p.argsFingerprint,
      p.argsText,
      p.resultJson,
      p.contributing,
      p.createdAt,
      p.expiresAt,
    );
    const id = Number(
      (this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint }).id,
    );

    const srvIns = this.db.prepare("INSERT OR IGNORE INTO tool_result_servers (entry_id, server) VALUES (?, ?)");
    for (const s of p.servers) srvIns.run(BigInt(id), s);

    if (p.embedding) {
      this.db
        .prepare("INSERT INTO vec_tool_results (rowid, embedding) VALUES (?, ?)")
        .run(BigInt(id), toBuffer(p.embedding));
    }
    return id;
  }

  getByFingerprint(tool: string, argsFingerprint: string): StoredEntry | null {
    const row = this.db
      .prepare("SELECT * FROM tool_results WHERE tool = ? AND args_fingerprint = ? LIMIT 1")
      .get(tool, argsFingerprint) as Record<string, unknown> | undefined;
    return row ? rowToEntry(row) : null;
  }

  getById(id: number): StoredEntry | null {
    const row = this.db
      .prepare("SELECT * FROM tool_results WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToEntry(row) : null;
  }

  deleteById(id: number): void {
    this.db.prepare("DELETE FROM tool_results WHERE id = ?").run(BigInt(id));
    this.db.prepare("DELETE FROM tool_result_servers WHERE entry_id = ?").run(BigInt(id));
    this.db.prepare("DELETE FROM vec_tool_results WHERE rowid = ?").run(BigInt(id));
  }

  /** k nearest neighbors by cosine similarity (1 = identical). */
  searchByEmbedding(vec: Float32Array, k: number): SearchHit[] {
    const nn = this.db
      .prepare(
        "SELECT rowid AS id, distance FROM vec_tool_results WHERE embedding MATCH ? ORDER BY distance LIMIT ?",
      )
      .all(toBuffer(vec), k) as { id: number | bigint; distance: number }[];

    if (nn.length === 0) return [];
    const placeholders = nn.map(() => "?").join(",");
    const ids = nn.map((r) => Number(r.id));
    const rows = this.db
      .prepare(`SELECT * FROM tool_results WHERE id IN (${placeholders})`)
      .all(...ids.map((i) => BigInt(i))) as Record<string, unknown>[];

    const byId = new Map<number, StoredEntry>();
    for (const r of rows) {
      const e = rowToEntry(r);
      byId.set(e.id, e);
    }
    return nn
      .map((r) => {
        const entry = byId.get(Number(r.id));
        if (!entry) return null;
        return { entry, similarity: 1 - r.distance };
      })
      .filter((x): x is SearchHit => x !== null);
  }

  /** Drop every entry contributed to by `serverName` (config-change invalidation). */
  invalidateServer(serverName: string): number {
    const ids = this.db
      .prepare("SELECT entry_id AS id FROM tool_result_servers WHERE server = ?")
      .all(serverName) as { id: number | bigint }[];
    for (const { id } of ids) this.deleteById(Number(id));
    return ids.length;
  }

  stats(): { entries: number; byServer: Record<string, number> } {
    const total = Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM tool_results").get() as { c: number | bigint }).c,
    );
    const rows = this.db
      .prepare("SELECT server, COUNT(*) AS c FROM tool_result_servers GROUP BY server")
      .all() as { server: string; c: number | bigint }[];
    const byServer: Record<string, number> = {};
    for (const r of rows) byServer[r.server] = Number(r.c);
    return { entries: total, byServer };
  }

  /** List cached entries, optionally filtered by namespaced tool or server. */
  listEntries(opts: { tool?: string; server?: string; limit?: number } = {}): StoredEntry[] {
    const limit = opts.limit ?? 50;
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.tool) {
      where.push("tool = ?");
      params.push(opts.tool);
    }
    if (opts.server) {
      where.push("id IN (SELECT entry_id FROM tool_result_servers WHERE server = ?)");
      params.push(opts.server);
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tool_results${clause} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }

  /** Delete every cached entry for a namespaced tool (e.g. "jira.get_issue"). */
  forgetTool(tool: string): number {
    const ids = this.db.prepare("SELECT id FROM tool_results WHERE tool = ?").all(tool) as {
      id: number | bigint;
    }[];
    for (const { id } of ids) this.deleteById(Number(id));
    return ids.length;
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "error closing memory store");
    }
  }
}
