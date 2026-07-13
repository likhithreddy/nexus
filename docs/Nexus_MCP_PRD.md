# Recall — MCP Aggregator with Memory
## Product Requirements Document (v0.1 — Initial Brainstorm)

---

## 1. Overview

**Recall** is an MCP (Model Context Protocol) aggregator that lets a user connect multiple MCP servers (Jira, draw.io, Playwright, GitHub, Slack, Postgres, etc.) behind a single interface, and adds a **memory layer** on top so that repeated or similar questions are answered from stored memory instead of re-invoking the LLM and/or the underlying MCP tools every time.

**Primary driver:** cost and latency optimization for LLM/tool calls. Every question that can be safely answered from memory should skip both the LLM call and the MCP tool call entirely.

---

## 2. Problem Statement

Users increasingly connect many MCP servers to a single AI assistant setup. Two problems emerge:

1. **Redundant cost/latency**: The same or semantically similar questions get asked repeatedly, each time triggering a full LLM round-trip and/or live tool calls, even when the answer hasn't changed.
2. **No aggregation layer**: There's no unified system that lets a user add MCPs dynamically (via a catalog or a custom command), see all available tools merged together, and have that tool set reload automatically as MCPs are added or removed.

Recall solves both: it acts as (a) an aggregation/routing layer across all connected MCPs, and (b) a memory layer that intercepts repeat questions before they reach the LLM or the tools.

---

## 3. Naming

Name shortlisted and selected during brainstorming: **Recall**.

Other candidates considered: MemMCP, Cortex, Synapse, Echo, Hivemind, Anamnesis, Nexus, Recollect.

Rationale for Recall: directly communicates the core behavior (recall an answer instead of regenerating one), reads well in both technical docs and product marketing ("Recall cache hit rate," "Recall gateway").

---

## 4. Core Design Decision: Two Distinct Memory Types

This was the most important architectural finding from the brainstorm. A single "semantic Q&A cache" is **not sufficient** — the concrete use case (Jira ticket status) revealed that Recall needs two distinct memory mechanisms:

### 4.1 Semantic Answer Cache (for stable/non-volatile knowledge)
- Used for questions whose answer doesn't change over time (e.g., "what's our deployment process," "how do I configure X MCP").
- Matching is done via **embedding similarity**, not exact string match.
- On a similarity hit above threshold → return the cached answer directly, with **no LLM call and no MCP tool call**.
- On a miss → route through the MCP aggregator → call relevant MCP tool(s) → LLM synthesizes the final answer → store the new answer + its embedding in the cache.

### 4.2 Entity Snapshot Store (for volatile, entity-tied facts)
- Used for facts tied to a specific external object whose state changes over time (e.g., a Jira ticket's status, a PR's review state).
- Keyed structurally, not semantically: `(source_mcp, entity_type, entity_id, attribute, value, timestamp)`.
  - Example row: `(jira, issue, "JIRA-123", status, "In Progress", 2026-07-06T14:00:00Z)`
- Each entity type has a **TTL / staleness policy** (e.g., a ticket status might be considered "fresh" only within the same calendar day; a document's creation date is effectively permanent and never expires).
- Behavior on repeat query:
  - **Same day, snapshot fresh** → return the stored value directly, no tool call.
  - **Later day, snapshot stale (or missing)** → do **not** silently serve stale data and do **not** silently refetch. Instead, tell the user the last known value and timestamp, and ask whether they want it refreshed live.
  - **User confirms refetch** → call the relevant MCP tool live → update the snapshot with the new value and timestamp → return the fresh answer.

This reconciles the original "strictly never call the LLM again for a repeated question" goal with the reality that some data changes over time and must not be served as if it were permanent truth.

---

## 5. Cacheability Classification

Not every question is cacheable the same way. Recall needs a classification step (rule-based initially, could be model-assisted later) that tags each incoming question as one of:

- **Stable/static** → eligible for the semantic answer cache, long or infinite TTL.
- **Entity-bound/volatile** → routed to the entity snapshot store with its type-specific TTL and the refetch-confirmation flow.
- **Non-cacheable/always-live** → e.g., "what's the current time," "run this Playwright test now" — always goes straight to the tool, never cached.

---

## 6. Matching Strategy Details

- Matching method: **embedding-based semantic similarity** (chosen over exact-text-match or hybrid, per brainstorm decision).
- Because Recall commits to **strict memory-serving on a hit** (no LLM verification step to catch a bad match), the similarity threshold must be **conservative** — recommended starting point is a high cosine similarity threshold (e.g., ~0.92+), tuned down only after observing real false-positive rates in production.
- Risk to track explicitly: a too-loose threshold could match two questions that are lexically similar but semantically distinct (e.g., "deployment process for staging" vs. "deployment process for production") and confidently serve the wrong cached answer with nothing to catch it. This is the single biggest risk in the strict-cache design and should have monitoring/alerting around match confidence scores in production.

---

## 7. Memory Storage Model — Unified, Not Siloed Per MCP

**Decision:** Do **not** maintain fully separate memory files/stores per MCP.

**Rationale:** Many real questions span multiple MCPs at once (e.g., "create a draw.io diagram of the Jira epics for this sprint" touches both Jira and draw.io). A siloed-per-MCP memory design cannot cache or reuse combined answers like this, and duplicates infrastructure per connector.

**Recommended model:** One unified memory store (covering both the semantic cache and the entity snapshot store), where every entry is **tagged with metadata**, including:
- Which MCP(s) and tool(s) contributed to the answer
- A fingerprint of the user's MCP configuration at the time the entry was created (see §8)
- Per-user/workspace scope, for multi-tenancy isolation

---

## 8. Cache Invalidation on MCP Configuration Change

If a user adds or removes an MCP after an answer was cached, that cached answer may now be stale or incorrect (it was generated using a different toolset). Recommendation:
- Store an **MCP configuration fingerprint** with each cache entry.
- When the user's connected MCP set changes, either invalidate affected entries or flag them for revalidation on next access, rather than serving them blindly forever.

---

## 9. Multi-Tenancy

- Memory (both semantic cache and entity snapshots) must be scoped per user/workspace by default.
- No cross-user leakage of cached answers or entity snapshots unless explicitly building a shared/org-wide memory mode (out of scope for v0.1 unless specified later).

---

## 10. MCP Aggregation Layer

### 10.1 Tool Discovery & Merging
- On connecting to any MCP server, Recall calls that server's `tools/list` (per MCP protocol) to retrieve its tool schemas.
- Tool names are **namespaced** to avoid collisions across servers (e.g., `jira.get_issue`, `drawio.create_diagram`, `playwright.click` — since two independent servers could each expose a tool literally called `search`).
- All namespaced tools from all connected MCPs are merged into a single manifest exposed to the LLM (and/or exposed as Recall's own `tools/list` if Recall itself acts as an MCP server to a downstream client).

### 10.2 Reload on Add/Remove
- Adding or removing an MCP triggers re-discovery and a "tools reloaded" event, so any active session picks up the updated merged tool manifest without requiring a restart.

---

## 11. Dynamic MCP Installation

Two supported paths:

### 11.1 Curated Catalog
- Recall ships with a maintained registry of well-known MCP servers (e.g., Jira, GitHub, Slack, Playwright, draw.io, Postgres).
- Each catalog entry defines an install spec, for example:
  ```json
  {
    "name": "jira",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-jira"],
    "requiredEnv": ["JIRA_API_TOKEN", "JIRA_BASE_URL"],
    "authType": "api_key",
    "notes": "MCP server itself is free/open source; requires a paid Atlassian account and API token."
  }
  ```
  or, for a remote server:
  ```json
  {
    "name": "some-remote-mcp",
    "transport": "sse",
    "url": "https://example.com/mcp",
    "authType": "oauth"
  }
  ```
- User selects an entry from the catalog; Recall prompts for any `requiredEnv` values, then installs/spawns or connects.
- **Important distinction to surface to users:** "free MCP server" (open source, no license cost) is not the same as "free underlying service" — e.g., the Jira MCP server is free, but still requires a paid Atlassian account behind it. Catalog entries should note this.

### 11.2 Freeform / Custom Install
- User supplies a command + args + optional env (same shape as a typical MCP client config entry), or a remote URL.
- Recall spawns the process (for stdio) or connects (for SSE/HTTP) using that spec, runs the MCP `initialize` handshake to confirm the server is alive, then runs tool discovery as in §10.1.

### 11.3 Post-Install
- After any successful install (catalog or freeform), Recall must re-run tool discovery and emit the "tools reloaded" event described in §10.2.

---

## 12. Authentication & Secrets Handling

- During MCP configuration, Recall must detect and prompt for whatever the server's install spec declares as required (API keys, tokens, base URLs, etc.).
- **API key / token-based auth**: prompt user via a secure form; store the secret **encrypted** (never plaintext) in a secrets store; inject as an environment variable at process-spawn time.
- **OAuth-based auth** (device-code flow or browser redirect): requires a separate, heavier flow — a callback listener and token storage/refresh logic. This should be designed and budgeted as a distinct workstream from simple API-key auth, not assumed to share the same UI/flow.

---

## 13. Illustrative Architecture Flows (from brainstorm session)

### 13.1 General Q&A Semantic Cache Flow
1. User asks a question.
2. Recall embeds the question and performs a semantic cache lookup against stored vectors.
3. **Cache hit** (similarity above threshold) → return the cached answer directly. No LLM call, no MCP call.
4. **Cache miss** → MCP aggregator dispatches to the relevant connected MCP(s) → LLM synthesizes an answer from the tool results → the new answer and its embedding are stored in memory (tagged with MCP config fingerprint and TTL) → answer returned to user.

### 13.2 Entity Snapshot / Staleness Flow (e.g., "what's the status of JIRA-123?")
1. User asks about a specific entity (e.g., JIRA-123).
2. Recall extracts the entity reference and checks the entity snapshot store by `(source, entity_id)`.
3. **Snapshot is fresh** (same day) → return the stored status directly, no MCP call.
4. **Snapshot is stale or missing** (earlier day, or never fetched) → tell the user the last known value and ask whether to refetch live.
5. If the user confirms → call the Jira MCP tool live → update the snapshot with the new value and timestamp → return the fresh answer to the user.

---

## 14. Technology Stack Recommendation

**Recommended: Node.js / TypeScript.**

Reasoning:
- The MCP ecosystem is overwhelmingly npm-centric — most community MCP servers are installed and run via `npx`, and the official TypeScript SDK is the most actively used/maintained one.
- Recall's core job (spawning and managing many child-process/stdio and SSE connections to MCP servers concurrently) fits Node's non-blocking I/O model well.
- The embeddings/vector-search layer is largely just API calls (to an embeddings endpoint) plus a vector database (e.g., Pinecone, Qdrant, pgvector) — this doesn't require Python's ML ecosystem, so it isn't a deciding factor.
- If a configuration/dashboard UI is also built (for adding MCPs, browsing memory, managing auth), using the same language front-to-back simplifies the stack.

**Python** remains a viable alternative if the team already has stronger backend experience there — plenty of MCP servers are themselves Python-based, which doesn't block Recall either way since they're just subprocesses. But absent an existing codebase pulling toward Python, Node/TypeScript is the recommended default for this project.

---

## 15. Open Questions / Risks for Follow-Up

1. **False-positive semantic matches** — needs a concrete threshold-tuning plan and production monitoring of match confidence scores before wide rollout.
2. **Entity extraction reliability** — how robustly can Recall extract entity references (e.g., "JIRA-123") from free-form natural language questions across all connected MCP types, not just Jira?
3. **Per-entity-type TTL configuration** — needs a concrete default TTL table per MCP/entity type (tickets vs. documents vs. PRs, etc.), and a way for users/admins to override it.
4. **OAuth flow design** — needs its own detailed spec (callback listener, token refresh, revocation).
5. **Event-driven snapshot updates** — should some entity snapshots be updated via webhooks (where the underlying service supports them) rather than only on-demand refetch? Not decided yet.
6. **Shared/org-wide memory mode** — out of scope for v0.1, but worth flagging as a possible v2 direction.
7. **Catalog maintenance** — process for keeping the curated MCP catalog (install specs, required env vars, auth type) up to date as servers change.

---

## 16. Summary of Key Decisions Made in This Session

| Decision | Choice |
|---|---|
| Product name | Recall |
| Primary driver | Cost/latency optimization for LLM calls |
| Question-matching strategy | Semantic similarity via embeddings |
| Memory storage split | Unified store, tagged by MCP/tool source — not siloed per MCP |
| Volatile entity data handling | Separate entity snapshot store with TTL + refetch-confirmation, distinct from semantic cache |
| Cache invalidation trigger | MCP configuration fingerprint per entry |
| Tool discovery | Standard MCP `tools/list`, namespaced, merged into one manifest, reloaded on add/remove |
| MCP installation | Curated catalog (predefined install specs) + freeform custom install (command/args or remote URL) |
| Auth handling | Encrypted secret storage for API keys; separate OAuth flow for services that require it |
| Tech stack | Node.js / TypeScript |

---

*End of v0.1 PRD — generated from initial brainstorming session, intended as a starting spec to hand off to implementation (e.g., via Claude Code).*
