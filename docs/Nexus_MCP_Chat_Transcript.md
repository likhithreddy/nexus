# Chat Transcript — Recall MCP Aggregator Brainstorm

---

**User:**
I want to build an MCP aggregator that has memory in it and users can custom add mcps to them and if a question is asked, related information will be kept in memory and if same question is asked, it should not talk to LLM instead fetch from memory strictly. Lets brainstorm this and first think of a good name for this MCP.

**Claude:**
Proposed the framing that this sits at the intersection of MCP routing/proxying and semantic caching. Offered a list of candidate names with rationale: MemMCP, Recall, Cortex/CortexMCP, Synapse, Echo, Hivemind, Anamnesis, Groundskeeper, Cache & Co., Nexus, Recollect — with top picks being Recall, Cortex, or Anamnesis.

Raised the core design tension up front: how does the system decide two questions are "the same" question? Exact string match is brittle; semantic similarity via embeddings is more robust but introduces judgment-call risk.

Asked two clarifying questions via interactive buttons:
1. How should the system decide a new question matches one already in memory?
2. What's the primary use case driving this?

**User (button selections):**
- Matching strategy: Semantic similarity (embeddings)
- Primary use case: Cost/latency optimization for LLM calls

**Claude:**
Recommended the name **Recall**, given the cost/latency-optimization framing — it directly communicates the product's function.

Laid out four key design problems given the "strict, no-LLM-fallback" caching approach:
1. False-positive semantic matches are the central risk, since there's no LLM verification step to catch a bad match — the similarity threshold must be conservative.
2. Not all questions are cacheable even if worded identically — time-sensitive/volatile queries (e.g., calendar, stock prices) need a classifier to flag them as non-cacheable or short-TTL, versus stable factual queries.
3. Answers are entangled with which MCPs were active when they were generated — if the user's MCP configuration changes later, previously cached answers could become stale or wrong; entries likely need to be scoped/fingerprinted to the MCP configuration active at creation time.
4. Per-user memory scoping is required for multi-tenancy — strict isolation per user/workspace unless deliberately building shared org memory.

Produced an architecture diagram showing the semantic cache flow: user question → embed & search memory → cache hit (return directly, no LLM/MCP call) vs. cache miss (MCP aggregator dispatches tools → LLM synthesizes answer → store answer + embedding in memory → return to user).

---

**User:**
Described a concrete use case: users can have multiple MCPs (Atlassian Jira MCP, draw.io MCP, Playwright MCP, etc.) and asked several sub-questions:
- Should there be separate memory files for all the MCPs added separately?
- Once all MCPs are configured, all their tools should be visible/merged.
- Should be able to add an MCP based on a user-given command.
- Should offer a curated/free set of famous MCP servers the user can select and install; for others, find all the ways to install based on command/args or remote URL, then reload all tools.
- Walked through a concrete example: if a user asks "what is the status of JIRA card #123" for the first time and it's "in progress," that should be saved. If asked again the same day, it should be fetched from memory (still in progress). If asked the next day, the user should be told it was in progress as of yesterday and asked whether to fetch it again live.
- All search use cases should be implemented based on user request.
- While configuring servers, users should be prompted for auth tokens/API keys if required.
- Asked whether this should be built as a Node/JavaScript server or Python, and which is recommended.

**Claude:**
Addressed each point:

1. **Memory storage model** — recommended against fully separate memory files per MCP, since many real questions span multiple MCPs at once (e.g., a draw.io diagram of Jira epics). Recommended a single unified memory store where every entry is tagged by which MCP(s)/tool(s) produced it.

2. **Two distinct memory mechanisms needed** — flagged that the Jira example actually requires a different mechanism than pure semantic Q&A caching:
   - A semantic vector cache for stable, non-volatile knowledge.
   - A structured entity-keyed snapshot store — `(source_mcp, entity_type, entity_id, attribute, value, timestamp)` — for facts tied to a specific mutable object (like a ticket's status), with per-entity-type TTL rules (e.g., a ticket's staleness window is roughly a day; a static document's metadata never expires).

   Produced a second architecture diagram showing the entity/staleness flow: user asks about JIRA-123 → check entity snapshot store → fresh snapshot (same day) → return directly, no MCP call; stale/missing snapshot → tell user last known value and ask whether to refetch → if confirmed, call the Jira MCP tool live → update the snapshot with a new timestamp → return answer.

3. **Tool visibility across MCPs** — described the standard MCP flow: call each connected server's `tools/list`, namespace tool names to avoid collisions (e.g., `jira.get_issue`, `drawio.create_diagram`), merge into one manifest, and re-run discovery with a "tools reloaded" event whenever an MCP is added or removed.

4. **Dynamic installation** — recommended two paths: a curated catalog of well-known MCP servers with predefined install specs (transport type, command/args or remote URL, required env vars, auth type), and a freeform path where the user supplies their own command/args/URL directly. Noted the distinction between a free/open-source MCP server and a paid underlying service (e.g., Jira MCP server is free, but still needs a paid Atlassian account/API token).

5. **Auth handling** — recommended prompting for required env vars/API keys during setup, storing them encrypted (never plaintext), and injecting them as environment variables at process-spawn time; called out that OAuth-based auth (device-code or browser redirect flow) is a separate, heavier flow that needs its own design rather than assuming one auth UI covers both cases.

6. **Language recommendation** — recommended Node.js/TypeScript over Python, reasoning that the MCP ecosystem is npm-centric (most community servers run via `npx`, and the TypeScript SDK is the most actively used), that Recall's core job (managing many concurrent child-process/stdio and SSE connections) fits Node's I/O model well, and that the embeddings/vector-search layer is mostly just API calls regardless of language. Noted Python remains a fine alternative if the team already has stronger experience there.

---

**User:**
Requested that everything discussed and decided be compiled into a Product Requirements Document (PRD) for download, along with a separate downloadable file containing the full chat transcript, to be taken forward into Claude Code.

**Claude:**
Produced this transcript file, along with a companion PRD file (`Recall_MCP_PRD.md`) covering: product naming, problem statement, the two-memory-type architecture (semantic cache + entity snapshot store), cacheability classification, matching/threshold strategy, unified vs. siloed memory storage decision, cache invalidation on MCP config change, multi-tenancy, MCP aggregation/tool-discovery design, dynamic installation (catalog + freeform), auth/secrets handling, both architecture flows described in text form, the Node.js/TypeScript stack recommendation with rationale, and a list of open questions/risks for follow-up.

---

*End of transcript.*
