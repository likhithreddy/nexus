import { describe, it, expect } from "vitest";
import { renderGraph } from "../src/graph.js";

describe("renderGraph", () => {
  it("renders connected servers with tools, cacheable markers, and memory counts", () => {
    const out = renderGraph({
      servers: [
        { name: "jira", transport: "stdio" },
        { name: "docs", transport: "stdio" },
      ],
      toolsByServer: new Map([
        ["jira", [{ name: "jira.get_issue", cacheable: true, description: "Get an issue" }]],
        ["docs", [{ name: "docs.read", cacheable: false }]],
      ]),
      connected: new Set(["jira", "docs"]),
      failed: new Set(),
      byServer: { jira: 3 },
    });
    expect(out).toContain("● jira [stdio]  (3 cached)");
    expect(out).toContain("└─ jira.get_issue [cacheable] — Get an issue");
    expect(out).toContain("● docs [stdio]");
    expect(out).toContain("└─ docs.read");
  });

  it("marks failed and disabled servers", () => {
    const out = renderGraph({
      servers: [
        { name: "dead", transport: "stdio" },
        { name: "off", transport: "stdio", enabled: false },
      ],
      toolsByServer: new Map(),
      connected: new Set(),
      failed: new Set(["dead"]),
      byServer: {},
    });
    expect(out).toContain("✕ dead [stdio]");
    expect(out).toContain("○ off [stdio]");
  });

  it("reports no tools for a connected but empty server", () => {
    const out = renderGraph({
      servers: [{ name: "empty", transport: "stdio" }],
      toolsByServer: new Map(),
      connected: new Set(["empty"]),
      failed: new Set(),
      byServer: {},
    });
    expect(out).toContain("└─ (no tools)");
  });

  it("returns a message when nothing is configured", () => {
    expect(
      renderGraph({
        servers: [],
        toolsByServer: new Map(),
        connected: new Set(),
        failed: new Set(),
        byServer: {},
      }),
    ).toBe("No servers configured.");
  });
});
