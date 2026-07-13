import { describe, it, expect } from "vitest";
import {
  argsFingerprint,
  argsToText,
  canonicalJson,
  contributingFingerprint,
} from "../src/memory/fingerprint.js";

describe("canonicalJson / argsFingerprint", () => {
  it("is key-order independent", () => {
    expect(argsFingerprint({ a: 1, b: 2 })).toBe(argsFingerprint({ b: 2, a: 1 }));
  });
  it("treats undefined and null args identically", () => {
    expect(argsFingerprint(undefined)).toBe(argsFingerprint(null));
  });
  it("changes when a value changes", () => {
    expect(argsFingerprint({ env: "staging" })).not.toBe(argsFingerprint({ env: "production" }));
  });
  it("sorts nested object keys", () => {
    expect(canonicalJson({ outer: { b: 1, a: 2 } })).toBe(
      canonicalJson({ outer: { a: 2, b: 1 } }),
    );
  });
});

describe("argsToText", () => {
  it("is stable and tool-scoped", () => {
    expect(argsToText("a.echo", { q: 1 })).toBe(argsToText("a.echo", { q: 1 }));
    expect(argsToText("a.echo", { q: 1 })).not.toBe(argsToText("b.echo", { q: 1 }));
  });
});

describe("contributingFingerprint", () => {
  it("is server-set order independent", () => {
    expect(contributingFingerprint(["jira", "github"])).toBe(
      contributingFingerprint(["github", "jira"]),
    );
  });
});
