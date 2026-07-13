# Nexus — MCP Aggregator with a Memory Layer

Nexus connects many MCP servers (Jira, GitHub, Postgres, …) behind a single
MCP gateway, and (in a later phase) adds a memory layer so repeated or
semantically similar tool calls are served from memory instead of re-invoking
the underlying tools every time.

> **Status (v0.1):** the **aggregation layer**, **memory layer** (per-tool TTL,
> semantic cache, gray-zone verifier), and **encrypted secret storage** (OS
> keychain) are built and tested. Memory caches cacheable (read-only/idempotent)
> tool results — exact-key and high-similarity hits serve with no tool call;
> misses forward and store. See [Memory layer](#memory-layer) and [Secrets](#secrets).

📖 **Full user guide & roadmap:** [`docs/Nexus_Guide.md`](docs/Nexus_Guide.md).
📚 **Command handbook (every command/flag/transport):** [`docs/Nexus_Handbook.md`](docs/Nexus_Handbook.md).
🧪 **How to install, use, and test it:** [`docs/Testing_Guide.md`](docs/Testing_Guide.md).

## Shape (decided)

Nexus is an **MCP gateway/proxy**: it is itself an MCP server. A downstream
client (Claude Desktop, Cursor, any MCP client) connects to Nexus; Nexus fans
out to the child MCP servers you configure, merges their tools into one
namespaced manifest, and forwards `tools/call` to the owning server.

- **Runtime:** local daemon + CLI. Config and (later) memory DB live in
  `NEXUS_HOME` (default `~/.nexus`). Secrets via OS keychain in a later phase.
- **Tool namespacing:** `<server>.<tool>` (dots are allowed in MCP tool names,
  per SEP-986). Example: `jira.get_issue`, `github.search`.
- **Live reload:** adding/removing a server re-runs discovery and emits
  `notifications/tools/list_changed`.

## Quick start

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # unit + end-to-end (in-memory MCP transports)
npm run build          # → dist/index.js (the `nexus` binary)
```

Add a server from the curated catalog, then run the gateway:

```bash
# Catalog install (prompts for required env if missing)
nexus add memory                       # knowledge-graph MCP, no auth — good first test
nexus add github                      # errors until you pass GITHUB_PERSONAL_ACCESS_TOKEN
nexus add github --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx

# Freeform install (use `--` before dash-leading args like npx's -y)
nexus add mygit --transport stdio --command npx \
  --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx -- -y @modelcontextprotocol/server-github

# Remote server
nexus add remotething --transport streamable-http --url https://example.com/mcp \
  --header Authorization=Bearer xyz

nexus list-servers                    # show configured child servers
nexus list-tools                      # connect live + print the merged manifest
nexus serve                           # run the MCP gateway on stdio
```

### Point a client at it

Add Nexus to your MCP client config as a stdio server, e.g. for Claude Desktop:

```jsonc
{
  "mcpServers": {
    "nexus": { "command": "node", "args": ["/abs/path/to/nexus/dist/index.js", "serve"] }
  }
}
```

All child servers' tools then appear under the `nexus.*` (well, `<server>.*`)
namespace in that client.

## CLI reference

```
nexus serve                                  Run the MCP gateway over stdio
nexus list-servers [--json|-j]               Show configured child servers
nexus list-tools [--json|-j]                 Connect + show the merged tool manifest
nexus add <catalog-name> [--env K=V]...      Install from the curated catalog
nexus add <name> --transport <t> [...]       Freeform install (stdio|sse|streamable-http)
nexus remove <name>                          Remove a configured server
nexus help
```

All logs go to **stderr**; stdout is reserved for the MCP wire protocol while
serving.

## Project structure

```
src/
  aggregation/   connectionManager · discovery · namespace · manifest · registry
  config/        schema (zod) · store · catalog · paths
  server/        gateway.ts — Nexus-as-MCP-server (merged tools/list + tools/call)
  cli/           index (router) · commands
  types.ts · logging.ts · version.ts · index.ts (public API)
catalog/servers.json   curated install specs (extend at ~/.nexus/catalog.json)
tests/                 namespace · manifest · end-to-end (in-memory transports)
```

## Key design notes (for contributors)

- **Tool namespacing & routing:** the merged `tools/list` rewrites each tool
  name to `<server>.<original>`. A separate route table maps each namespaced
  name back to `(server, originalName)` — the client never sees routing metadata.
- **Cacheability seam:** `isCacheableTool(tool)` derives from MCP annotations
  (`readOnlyHint`/`idempotentHint` → cacheable; `destructiveHint` → never). The
  memory layer will consume this; it is **not** used to filter the manifest.
- **ConnectionManager** supports `stdio`, `sse`, and `streamable-http`. Stdio
  child stderr is surfaced in Nexus logs. A transport factory is injectable for
  tests (see `tests/registry.integration.test.ts`).
- **Validation:** zod handles shape/defaults; transport-conditional rules
  (stdio needs `command`, remote needs `url`) live in `validateServerConfig`.

## Memory layer

Opt-in. On `nexus serve`, enable it with one of:
- `OPENAI_API_KEY` → OpenAI `text-embedding-3-small` (1536-dim).
- `NEXUS_EMBEDDING=hash` → offline deterministic embedder (testing / air-gapped; not semantically meaningful).

With memory on, a `tools/call` to a **cacheable** tool (MCP annotations
`readOnlyHint`/`idempotentHint`, not `destructiveHint`) is intercepted:

1. **Exact args-fingerprint hit** → served from memory, no child call (the fast
   path — no embedding needed).
2. Otherwise embed the call and run a **nearest-neighbor** search (sqlite-vec):
   - similarity ≥ 0.92 → served (semantic hit)
   - 0.85–0.92 → *gray zone* → an LLM verifier decides (accept serves cached; reject refetches). No verifier/key → refetch.
   - below → miss
3. **Miss** → forward to the child; store the result if it isn't an error.

Structurally distinct args (`env:"staging"` vs `"production"`) have different
fingerprints → separate entries, so the staging/production trap is avoided
*before* similarity is even consulted.

Store: SQLite (`~/.nexus/memory.db`) + `sqlite-vec`, via Node's built-in
`node:sqlite` (no native build). Removing a server drops its cache entries.

### Per-tool TTL (entity snapshots)

By default cacheable results never expire (stable knowledge). Override volatile
tools in `~/.nexus/config.json`:

```jsonc
{
  "ttl": {
    "jira.get_issue": "1d",   // ticket status refreshes daily
    "github.*": "12h",        // all tools from a server
    "*": "30s"                // global fallback
  }
}
```

Precedence: exact `<server>.<tool>` > `<server>.*` > `*` > Infinity. Values are
durations (`30s`, `5m`, `12h`, `1d`, ms number) or `never`. Expired entries are
refetched on next call.

## Secrets

Secrets (tokens, API keys) are stored **encrypted in the OS keychain** — never
in `config.json`. On `nexus add`:

- `--env K=V` → stored in the keychain (recorded as `secretEnv` in config).
- `--plain-env K=V` → plaintext in config (for non-secrets like base URLs).

At `nexus serve`, each server's `secretEnv` is resolved from the keychain and
injected into the child's spawn env. `nexus remove` purges that server's secrets.
If the OS keychain is unavailable, `--env` falls back to plaintext config with a
warning.

### Current limitations (deliberate, v0.1)
- **TTL defaults to infinite** — stable tools cache forever; volatile tools need
  an explicit override (above). No automatic "this tool looks time-sensitive" heuristic.
- **No "serve stale + freshness signal"** — expired entries are treated as misses
  (refetched), not returned with a staleness flag. This deviates from PRD §4.2's
  confirm-to-refetch flow, which doesn't fit a non-interactive gateway.
- **LLM verifier needs a key** — without `OPENAI_API_KEY`, gray-zone matches
  refetch (no verify).

See `docs/Nexus_MCP_PRD.md` for the full design rationale.
