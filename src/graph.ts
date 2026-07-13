/**
 * Pure topology renderer shared by the `nexus graph` CLI command and the
 * `nexus.graph` meta-tool. No IO — takes already-collected data, returns text.
 */
export interface GraphServer {
  name: string;
  transport: string;
  enabled?: boolean;
}
export interface GraphTool {
  name: string;
  description?: string;
  cacheable: boolean;
}
export interface GraphInput {
  servers: GraphServer[];
  toolsByServer: Map<string, GraphTool[]>;
  connected: Set<string>;
  failed: Set<string>;
  byServer: Record<string, number>;
}

export function renderGraph(g: GraphInput): string {
  if (g.servers.length === 0) return "No servers configured.";
  const lines: string[] = [];
  for (const s of g.servers) {
    const on = g.connected.has(s.name);
    const off = s.enabled === false;
    const mark = on ? "●" : off ? "○" : "✕";
    const mem = g.byServer[s.name] ?? 0;
    const memStr = mem ? `  (${mem} cached)` : "";
    lines.push(`${mark} ${s.name} [${s.transport}]${memStr}`);
    if (!on) {
      const why = g.failed.has(s.name) ? " (failed — see stderr)" : off ? " (disabled)" : " (not connected)";
      lines.push(`    └─${why}`);
      continue;
    }
    const tools = g.toolsByServer.get(s.name) ?? [];
    if (tools.length === 0) {
      lines.push("    └─ (no tools)");
      continue;
    }
    for (const t of tools) {
      const cache = t.cacheable ? " [cacheable]" : "";
      const desc = t.description ? ` — ${t.description.split("\n")[0]!.slice(0, 50)}` : "";
      lines.push(`    └─ ${t.name}${cache}${desc}`);
    }
  }
  return lines.join("\n");
}
