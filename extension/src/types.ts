// DTOs mirrored from the backend (src/backend/types.ts). Never import from src/.

export interface HealthInfo {
  ok: boolean;
  version: string;
  tools: number;
  servers: number;
}

export interface QaLookupResult {
  hit: boolean;
  band?: string;
  similarity?: number;
  entryId?: number;
  answer?: string;
}

export interface QaStoreResult {
  entryId: number;
  ttlMs: number | null;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

export interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface StatsInfo {
  entries: number;
  byServer: Record<string, number>;
  hits: number;
  misses: number;
  qa: { entries: number; hits: number; misses: number };
}
