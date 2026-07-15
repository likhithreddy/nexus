import type { HealthInfo, QaLookupResult, QaStoreResult, McpTool, ToolCallResult, StatsInfo } from "./types";

/** Typed HTTP client for the Nexus backend (fetch-based, no deps). */
export class BackendClient {
  constructor(private baseUrl: string, private token?: string) {}

  private async req<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`backend ${res.status}: ${text}`);
    }

    return (await res.json()) as T;
  }

  health(): Promise<HealthInfo> {
    return this.req<HealthInfo>("/health");
  }

  tools(): Promise<McpTool[]> {
    return this.req<McpTool[]>("/tools");
  }

  callTool(name: string, args?: unknown): Promise<ToolCallResult> {
    return this.req<ToolCallResult>("/tools/call", "POST", { name, args });
  }

  qaLookup(question: string, contextSignature = ""): Promise<QaLookupResult> {
    return this.req<QaLookupResult>("/qa/lookup", "POST", { question, contextSignature });
  }

  qaStore(data: {
    question: string;
    answer: string;
    toolsUsed: string[];
    contextSignature?: string;
  }): Promise<QaStoreResult> {
    return this.req<QaStoreResult>("/qa/store", "POST", data);
  }

  stats(): Promise<StatsInfo> {
    return this.req<StatsInfo>("/stats");
  }

  reload(): Promise<{ ok: number; failed: string[] }> {
    return this.req("/reload", "POST");
  }
}
