import { describe, it, expect } from "vitest";
import { classifySimilarity, isExpired, HIT_THRESHOLD, GRAY_LOW } from "../src/memory/policy.js";

describe("classifySimilarity", () => {
  it("returns hit at/above the threshold", () => {
    expect(classifySimilarity(HIT_THRESHOLD)).toBe("hit");
    expect(classifySimilarity(0.99)).toBe("hit");
  });
  it("returns gray in the verify band", () => {
    expect(classifySimilarity(GRAY_LOW)).toBe("gray");
    expect(classifySimilarity(0.78)).toBe("gray");
  });
  it("returns miss below the gray band", () => {
    expect(classifySimilarity(0.5)).toBe("miss");
    expect(classifySimilarity(0)).toBe("miss");
  });
});

describe("isExpired", () => {
  const now = 1_000_000;
  it("never expires when expiresAt is null", () => {
    expect(isExpired(null, now)).toBe(false);
  });
  it("is fresh in the future", () => {
    expect(isExpired(now + 5_000, now)).toBe(false);
  });
  it("is expired in the past", () => {
    expect(isExpired(now - 1, now)).toBe(true);
  });
});
