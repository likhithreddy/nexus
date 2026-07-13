import { logger } from "../logging.js";

/**
 * A gray-zone verifier (PRD §6 / the "tiered" cache policy). When a semantic
 * nearest-neighbor lands in the gray band (~0.85–0.92 similarity), the cached
 * result is *probably* the answer to the new call but not certainly. Rather
 * than serve blindly or refetch blindly, a verifier decides whether the cached
 * result is safe to reuse.
 */

export interface VerifyContext {
  /** Namespaced tool name of the incoming call. */
  tool: string;
  /** Incoming call args. */
  args: unknown;
  /** The embedded text (tool + canonical args) of the cached candidate. */
  candidateArgsText: string;
  /** The cached result, serialized. */
  candidateResultJson: string;
  /** The cosine similarity that placed this in the gray band. */
  similarity: number;
}

export interface VerifyResult {
  accept: boolean;
  reason?: string;
}

export interface Verifier {
  verify(ctx: VerifyContext): Promise<VerifyResult>;
}

/** Always rejects → the cache refetches. The safe default when no LLM is wired. */
export class NoopVerifier implements Verifier {
  async verify(): Promise<VerifyResult> {
    return { accept: false, reason: "no verifier configured" };
  }
}

/** A function that asks the client's LLM (via MCP sampling) and returns text. */
export interface Sampler {
  sample(prompt: string): Promise<string>;
}

/**
 * Verifier that asks the *connected client's* LLM (the "coding harness") via MCP
 * `sampling/createMessage` — keyless, uses whatever LLM the client brings. This
 * is the default verifier. If the client doesn't support sampling (or the call
 * fails), it rejects → the cache refetches.
 */
export class SamplingVerifier implements Verifier {
  constructor(private sampler: Sampler) {}

  async verify(ctx: VerifyContext): Promise<VerifyResult> {
    const newArgs = JSON.stringify(ctx.args ?? null);
    const prompt = [
      "You are a cache verifier for an MCP tool aggregator. Two tool calls are shown.",
      "Decide if the CACHED result would be a correct answer for the NEW request — i.e. the two",
      "requests ask for the same thing such that the answer would not meaningfully differ.",
      "Reply with exactly one word: YES or NO.",
      "",
      `Cached request: tool=${ctx.tool} args=${ctx.candidateArgsText}`,
      `New request:    tool=${ctx.tool} args=${newArgs}`,
    ].join("\n");
    try {
      const reply = (await this.sampler.sample(prompt)).trim().toUpperCase();
      const accept = reply.startsWith("Y");
      return { accept, reason: accept ? "sampling-yes" : "sampling-no" };
    } catch (err) {
      return { accept: false, reason: `sampling-unavailable: ${(err as Error).message}` };
    }
  }
}

/**
 * LLM-backed verifier. Asks a small/fast chat model whether the cached result
 * answers the new request. Requires OPENAI_API_KEY at construction; not exercised
 * by tests (no network). Model overridable via NEXUS_VERIFY_MODEL.
 */
export class LLMVerifier implements Verifier {
  private apiKey: string;
  private model: string;
  private endpoint = "https://api.openai.com/v1/chat/completions";

  constructor(apiKey = process.env.OPENAI_API_KEY, model = process.env.NEXUS_VERIFY_MODEL ?? "gpt-4o-mini") {
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for LLMVerifier");
    this.apiKey = apiKey;
    this.model = model;
  }

  async verify(ctx: VerifyContext): Promise<VerifyResult> {
    const newArgs = JSON.stringify(ctx.args ?? null);
    const prompt = [
      "You are a cache verifier for an MCP tool aggregator. Two tool calls are shown.",
      "Decide if the CACHED result would be a correct answer for the NEW request — i.e. the two",
      "requests ask for the same thing such that the answer would not meaningfully differ.",
      "Reply with exactly one word: YES or NO.",
      "",
      `Cached request: tool=${ctx.tool} args=${ctx.candidateArgsText}`,
      `New request:    tool=${ctx.tool} args=${newArgs}`,
    ].join("\n");

    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_tokens: 5,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        return { accept: false, reason: `verifier http ${res.status}` };
      }
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      const content = (json.choices[0]?.message?.content ?? "").trim().toUpperCase();
      const accept = content.startsWith("Y");
      return { accept, reason: accept ? "llm-yes" : "llm-no" };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "verifier call failed → rejecting");
      return { accept: false, reason: "verifier-error" };
    }
  }
}
