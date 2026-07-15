/** DTOs for the backend REST API (mirrored in the extension, never imported). */

export interface HealthResponse {
  ok: boolean;
  version: string;
  tools: number;
  servers: number;
}

export interface QaLookupRequest {
  question: string;
  contextSignature?: string;
}

export interface QaLookupResponse {
  hit: boolean;
  band?: string;
  similarity?: number;
  entryId?: number;
  answer?: string;
}

export interface QaStoreRequest {
  question: string;
  answer: string;
  toolsUsed: string[];
  contextSignature?: string;
}

export interface QaStoreResponse {
  entryId: number;
  ttlMs: number;
}

export interface ToolCallRequest {
  name: string;
  args?: unknown;
}

export interface StatsResponse {
  entries: number;
  byServer: Record<string, number>;
  hits: number;
  misses: number;
  qa: { entries: number; hits: number; misses: number };
}

export interface ListeningEvent {
  event: "listening";
  port: number;
  host: string;
  token?: string;
}
