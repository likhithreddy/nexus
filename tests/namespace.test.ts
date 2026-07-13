import { describe, it, expect } from "vitest";
import {
  normalizeServerName,
  namespaceToolName,
  parseNamespacedToolName,
  isCacheableTool,
} from "../src/aggregation/namespace.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const tool = (over: Partial<Tool> = {}): Tool =>
  ({ name: "x", inputSchema: { type: "object" }, ...over }) as Tool;

describe("normalizeServerName", () => {
  it("lowercases and collapses non-slug chars to dashes", () => {
    expect(normalizeServerName("Draw.io")).toBe("draw-io");
    expect(normalizeServerName("Jira Server #2!")).toBe("jira-server-2");
  });
  it("strips dots so the prefix never collides with the namespace separator", () => {
    expect(normalizeServerName("a.b.c")).toBe("a-b-c");
    expect(normalizeServerName("a.b.c")).not.toContain(".");
  });
  it("trims leading/trailing dashes", () => {
    expect(normalizeServerName("--weird--")).toBe("weird");
  });
});

describe("namespaceToolName / parseNamespacedToolName", () => {
  it("joins server + tool with a single dot", () => {
    expect(namespaceToolName("jira", "get_issue")).toBe("jira.get_issue");
  });
  it("splits on the FIRST dot, so dotted tool names still route", () => {
    expect(parseNamespacedToolName("jira.issue.get")).toEqual({
      serverName: "jira",
      originalName: "issue.get",
    });
  });
  it("returns empty server when there is no separator", () => {
    expect(parseNamespacedToolName("list")).toEqual({ serverName: "", originalName: "list" });
  });
});

describe("isCacheableTool", () => {
  it("is cacheable when readOnlyHint is true", () => {
    expect(isCacheableTool(tool({ annotations: { readOnlyHint: true } }))).toBe(true);
  });
  it("is cacheable when idempotentHint is true", () => {
    expect(isCacheableTool(tool({ annotations: { idempotentHint: true } }))).toBe(true);
  });
  it("is NOT cacheable when destructiveHint is true, even if also readOnly", () => {
    expect(
      isCacheableTool(tool({ annotations: { readOnlyHint: true, destructiveHint: true } })),
    ).toBe(false);
  });
  it("defaults to NOT cacheable when annotations are absent", () => {
    expect(isCacheableTool(tool())).toBe(false);
  });
  it("is NOT cacheable for an empty annotations object", () => {
    expect(isCacheableTool(tool({ annotations: {} }))).toBe(false);
  });
});
