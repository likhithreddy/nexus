import { describe, it, expect } from "vitest";
import { parseDuration, buildTtlResolver, looksVolatile, composeTtlResolver } from "../src/memory/ttl.js";

describe("parseDuration", () => {
  it("parses unit suffixes", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("12h")).toBe(43_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
  });
  it("treats a bare number / digit-only string as ms", () => {
    expect(parseDuration(250)).toBe(250);
    expect(parseDuration("1000")).toBe(1000);
  });
  it("never / Infinity mean no expiry", () => {
    expect(parseDuration("never")).toBe(Infinity);
    expect(parseDuration("Infinity")).toBe(Infinity);
  });
  it("rejects garbage", () => {
    expect(() => parseDuration("soon")).toThrow();
  });
});

describe("buildTtlResolver precedence", () => {
  const r = buildTtlResolver({
    "jira.get_issue": "1d",
    "jira.*": "12h",
    "github.*": "5m",
    "*": "30s",
  });

  it("exact name wins", () => {
    expect(r("jira.get_issue")).toBe(86_400_000);
  });
  it("server wildcard beats global", () => {
    expect(r("jira.create_issue")).toBe(43_200_000); // jira.*
    expect(r("github.search")).toBe(300_000); // github.*
  });
  it("global wildcard is the fallback", () => {
    expect(r("postgres.query")).toBe(30_000); // *
  });
  it("defaults to Infinity with no overrides", () => {
    const none = buildTtlResolver({});
    expect(none("anything.go")).toBe(Infinity);
  });
});

describe("looksVolatile (time-sensitivity heuristic)", () => {
  it("flags volatile-looking tools", () => {
    expect(looksVolatile("jira.get_issue_status")).toBe(true);
    expect(looksVolatile("ci.latest_build")).toBe(true);
    expect(looksVolatile("metrics.now")).toBe(true);
  });
  it("leaves stable-looking tools alone", () => {
    expect(looksVolatile("docs.get_doc")).toBe(false);
    expect(looksVolatile("github.get_repo")).toBe(false);
  });
});

describe("composeTtlResolver (explicit + heuristic)", () => {
  it("explicit overrides heuristics", () => {
    const r = composeTtlResolver({ explicit: buildTtlResolver({ "jira.get_issue_status": "1d" }), heuristics: true });
    expect(r("jira.get_issue_status")).toBe(86_400_000);
  });
  it("applies default heuristic TTL to volatile tools when enabled", () => {
    const r = composeTtlResolver({ explicit: buildTtlResolver({}), heuristics: true });
    expect(r("jira.get_issue_status")).toBe(300_000); // 5m
    expect(r("docs.get_doc")).toBe(Infinity);
  });
  it("is Infinity for volatile tools when heuristics are off", () => {
    const r = composeTtlResolver({ explicit: buildTtlResolver({}), heuristics: false });
    expect(r("jira.get_issue_status")).toBe(Infinity);
  });
  it("honors a custom heuristicTtlMs", () => {
    const r = composeTtlResolver({ explicit: buildTtlResolver({}), heuristics: true, heuristicTtlMs: 1000 });
    expect(r("svc.now")).toBe(1000);
  });
});
