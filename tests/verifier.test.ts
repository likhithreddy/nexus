import { describe, it, expect } from "vitest";
import { SamplingVerifier, NoopVerifier, type VerifyContext } from "../src/memory/verifier.js";

const ctx: VerifyContext = {
  tool: "srv.echo",
  args: { q: "x" },
  candidateArgsText: 'srv.echo\n{"q":"x"}',
  candidateResultJson: "{}",
  similarity: 0.78,
};

describe("SamplingVerifier (harness-driven)", () => {
  it("accepts when the harness LLM says YES", async () => {
    const v = new SamplingVerifier({ sample: async () => "YES" });
    expect((await v.verify(ctx)).accept).toBe(true);
  });
  it("rejects when the harness LLM says NO", async () => {
    const v = new SamplingVerifier({ sample: async () => "no" });
    expect((await v.verify(ctx)).accept).toBe(false);
  });
  it("rejects gracefully when sampling is unsupported (client lacks it)", async () => {
    const v = new SamplingVerifier({
      sample: async () => {
        throw new Error("method not found");
      },
    });
    const r = await v.verify(ctx);
    expect(r.accept).toBe(false);
    expect(r.reason ?? "").toMatch(/sampling-unavailable/);
  });
});

describe("NoopVerifier", () => {
  it("always rejects", async () => {
    expect((await new NoopVerifier().verify()).accept).toBe(false);
  });
});
