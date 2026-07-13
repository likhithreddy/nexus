import { createRequire } from "node:module";
import path from "node:path";
import { getNexusHome } from "../config/paths.js";

/**
 * Embedding providers for the semantic cache. Pluggable so tests use a
 * deterministic offline embedder, production defaults to a LOCAL model (keyless),
 * and OpenAI is available as an opt-in alternative.
 */
export interface Embedder {
  /** Vector dimensionality this embedder produces. */
  readonly dimension: number;
  /** Embed a batch of texts; returns one Float32Array (L2-normalized) per input. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Cosine similarity for two equal-length Float32Arrays (assumed normalized). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** L2-normalize a vector in place and return it. */
export function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

/**
 * DEFAULT — local embeddings, no API key. Runs `bge-small-en-v1.5` in-process via
 * transformers.js (ONNX). Model downloads once on first use (cached under
 * NEXUS_HOME/models), then runs fully offline. No native build / install script,
 * so it survives npm v12's `allowScripts`-off default.
 */
const LOCAL_MODEL = "Xenova/bge-small-en-v1.5";
const LOCAL_DIM = 384;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineFn: ((task: string, model: string) => Promise<any>) | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractorPromise: Promise<any> | undefined;

async function getExtractor(): Promise<unknown> {
  if (!pipelineFn) {
    // Load transformers.js through createRequire so the bundler doesn't try to
    // rewrite/inline it (same approach as node:sqlite and keytar).
    const tf = createRequire(import.meta.url)("@huggingface/transformers") as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pipeline: (task: string, model: string) => Promise<any>;
      env: { cacheDir: string };
    };
    tf.env.cacheDir = path.join(getNexusHome(), "models");
    pipelineFn = tf.pipeline;
  }
  if (!extractorPromise) extractorPromise = pipelineFn!("feature-extraction", LOCAL_MODEL);
  return extractorPromise;
}

export class LocalEmbedder implements Embedder {
  readonly dimension = LOCAL_DIM;

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extractor: any = await getExtractor();
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    const list = out.tolist() as number[][];
    return list.map((arr) => Float32Array.from(arr));
  }
}

/**
 * OpenAI text-embedding-3-small (1536-dim). Opt-in alternative for users who
 * prefer it; requires OPENAI_API_KEY. Not the default.
 */
export class OpenAIEmbedder implements Embedder {
  readonly dimension = 1536;
  private apiKey: string;
  private model = "text-embedding-3-small";
  private endpoint = "https://api.openai.com/v1/embeddings";

  constructor(apiKey = process.env.OPENAI_API_KEY) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for OpenAIEmbedder");
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embeddings failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => normalize(Float32Array.from(d.embedding)));
  }
}

/**
 * Deterministic, offline embedder for tests. Same text → same normalized vector
 * (cosineSimilarity 1 for identical, ~0 for different). NOT semantically meaningful.
 */
export class HashEmbedder implements Embedder {
  readonly dimension: number;

  constructor(dimension = 16) {
    this.dimension = dimension;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dimension);
    let seed = 2166136261;
    for (let i = 0; i < text.length; i++) {
      seed ^= text.charCodeAt(i);
      seed = Math.imul(seed, 16777619);
    }
    for (let i = 0; i < this.dimension; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      v[i] = ((seed >>> 0) % 1000) / 1000 - 0.5;
    }
    return normalize(v);
  }
}
