import { describe, it, expect } from "vitest";
import { dashboardHtml } from "../src/cli/commands.js";

describe("dashboardHtml", () => {
  it("renders title, counts, the graph, and escapes HTML", () => {
    const html = dashboardHtml({
      graph: "● jira [stdio]\n    └─ <weird>",
      entries: 3,
      byServer: { jira: 2 },
      serverCount: 1,
      generatedAt: "now",
    });
    expect(html).toContain("<title>Nexus</title>");
    expect(html).toContain("<strong>1</strong> configured server");
    expect(html).toContain("<strong>3</strong> cached entries");
    // graph content is HTML-escaped so injected markup can't break the page
    expect(html).toContain("&lt;weird&gt;");
    expect(html).not.toContain("<weird>");
    expect(html).toContain("<td>jira</td><td>2</td>");
  });

  it("shows (none) when there is no per-server memory", () => {
    const html = dashboardHtml({
      graph: "No servers configured.",
      entries: 0,
      byServer: {},
      serverCount: 0,
      generatedAt: "now",
    });
    expect(html).toContain("<strong>0</strong> configured server");
    expect(html).toContain("<strong>0</strong> cached entries");
    expect(html).toContain('colspan="2">(none)');
  });
});
