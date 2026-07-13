import { describe, it, expect } from "vitest";
import { buildNamespacedEntries, mergeEntries } from "../src/aggregation/manifest.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const tool = (name: string, over: Partial<Tool> = {}): Tool =>
  ({ name, inputSchema: { type: "object" }, ...over }) as Tool;

describe("buildNamespacedEntries", () => {
  it("rewrites each tool name to server.tool and keeps originals in metadata", () => {
    const entries = buildNamespacedEntries("jira", [
      tool("get_issue", { annotations: { readOnlyHint: true } }),
      tool("create_issue", { annotations: { destructiveHint: true } }),
    ]);
    expect(entries.map((e) => e.tool.name)).toEqual(["jira.get_issue", "jira.create_issue"]);
    expect(entries[0]!.originalName).toBe("get_issue");
    expect(entries[0]!.namespacedName).toBe("jira.get_issue");
    // cacheability seam derived from annotations
    expect(entries[0]!.cacheable).toBe(true);
    expect(entries[1]!.cacheable).toBe(false);
  });
});

describe("mergeEntries", () => {
  it("merges across servers into one manifest + route table", () => {
    const merged = mergeEntries([
      buildNamespacedEntries("jira", [tool("get_issue", { annotations: { readOnlyHint: true } })]),
      buildNamespacedEntries("github", [tool("search")]),
    ]);
    expect(merged.tools.map((t) => t.name).sort()).toEqual(["github.search", "jira.get_issue"]);
    expect(merged.routes.size).toBe(2);
    expect(merged.routes.get("jira.get_issue")?.cacheable).toBe(true);
    expect(merged.routes.get("jira.get_issue")?.serverName).toBe("jira");
    expect(merged.routes.get("jira.get_issue")?.originalName).toBe("get_issue");
  });

  it("keeps first on a namespaced-name collision and records the duplicate", () => {
    // Two different servers can't normally produce the same namespaced name,
    // but a misconfigured catalog (duplicate server names) could.
    const merged = mergeEntries([
      buildNamespacedEntries("jira", [tool("get_issue")]),
      buildNamespacedEntries("jira", [tool("get_issue")]),
    ]);
    expect(merged.tools).toHaveLength(1);
    expect(merged.duplicates).toEqual(["jira.get_issue"]);
  });
});
