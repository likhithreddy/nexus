# Nexus — Guide & Documentation

> **Scope, up front:** Nexus is a **local, single-user** tool. It runs on *your*
> machine, stores *your* config and memory on *your* disk, and reads *your* OS
> keychain. It is **not** a shared or multi-tenant MCP server. There is no
> server you connect other people to. (A hosted/shared mode is a possible future
> direction — see [Roadmap](#12-roadmap--book-of-work) — but it is explicitly
> out of scope today.)

Nexus is an **MCP aggregator with a memory layer**. You point your AI assistant
(Claude Desktop, Cursor, any MCP client) at Nexus once; Nexus then stands behind
it connected to all your MCP servers (Jira, GitHub, Postgres, a browser, etc.),
merges their tools into one clean list, and **remembers answers** so repeated or
similar questions are served from memory instead of re-running the underlying
tools every time — saving latency and cost.

This document is the canonical user guide. Status is **v0.1**: the core works and
is tested, but several things on the [Roadmap](#12-roadmap--book-of-work) are not
built yet.

---

## 1. What Nexus is

An AI assistant that supports MCP can connect to MCP servers — bridges that give
the AI tools (read a Jira ticket, query Postgres, fetch a web page). Two problems
emerge as you connect more of them:

1. **Many connections to manage, and tools collide** (two servers can each expose
   a `search`).
2. **Redundant cost/latency** — the same tool calls run again and again even when
   the answer hasn't changed.

Nexus solves both: it is itself an MCP server that **aggregates** all your other
servers behind one connection (namespacing tools so they never collide) and adds
a **memory layer** that short-circuits repeat calls.

### The shape (decided)

Nexus is a **gateway/proxy**:

```
Your AI client (Claude Desktop, Cursor, …)
        │  one MCP connection
        ▼
     Nexus  ──────────►  Memory (SQLite + sqlite-vec)
        │
   ┌────┼────┬─────────┐
   ▼    ▼    ▼         ▼
 Jira  GitHub  Postgres  … (your MCP servers)
```

The AI client owns the LLM; Nexus owns tool routing + memory. When the client
calls a tool, Nexus checks memory first; on a hit it returns the stored result
(no tool call); on a miss it forwards to the right child server and stores the
answer.

---

## 2. How it works

- **Discovery:** on startup, Nexus connects to each configured MCP server, calls
  its `tools/list`, and namespaces every tool as `<server>.<tool>`
  (e.g. `jira.get_issue`, `github.search`). All namespaced tools are merged into
  one manifest exposed to your AI client.
- **Forwarding:** when the AI calls `jira.get_issue`, Nexus routes it to the
  `jira` server and returns the result.
- **Memory (opt-in):** for **cacheable** tools (read-only / idempotent — derived
  from the tool's own annotations), Nexus checks memory before forwarding:
  1. **Exact repeat** (same tool + same arguments) → served instantly from memory.
  2. **Semantically similar** (same meaning, different wording) → matched by
     embedding similarity; a high-confidence match is served, a borderline one is
     double-checked by a verifier.
  3. **Miss** → forwarded to the child; the result is stored for next time.
- **Freshness:** each tool can have a TTL. Stable tools (a doc, repo metadata)
  cache forever; volatile tools (a ticket status) refresh after you configure a
  window.
- **Secrets:** API tokens live **encrypted in your OS keychain**, never in
  plaintext config.
- **Live reload:** add or remove a server and Nexus re-discovers and updates the
  merged tool list without a restart.

---

## 3. Install & build

Requirements: **Node.js 20+** (developed on Node 25), npm.

```bash
git clone <your-repo> nexus
cd nexus
npm install
npm run build      # produces dist/index.js — the `nexus` program
```

> Nexus is **not yet published to npm** (see Roadmap). For now you run it from
> this checkout. You can invoke it directly with `node dist/index.js …`, or via
> the npm scripts below.

Useful scripts:

| Script | What it does |
|---|---|
| `npm run build` | Compile to `dist/index.js` (the binary) |
| `npm run dev -- <cmd>` | Run a CLI command from source via tsx |
| `npm run serve` | Run the gateway from source (`tsx … serve`) |
| `npm run typecheck` | Type-check the project |
| `npm test` | Run the test suite |

---

## 4. The CLI

All commands read/write data under **`NEXUS_HOME`** (default `~/.nexus`):
- `~/.nexus/config.json` — your servers + TTL settings
- `~/.nexus/memory.db` — the memory store (when memory is enabled)
- `~/.nexus/catalog.json` — optional catalog overrides

```
nexus serve                                  Run the MCP gateway over stdio
nexus list-servers [--json|-j]               Show configured child servers
nexus list-tools [--json|-j]                 Connect live + show the merged tool manifest
nexus add <catalog-name> [--env K=V]...      Install a server from the curated catalog
nexus add <name> --transport <t> [...]       Freeform install (stdio | sse | streamable-http)
nexus remove <name>                          Remove a server (+ purge its keychain secrets)
nexus memory stats|list|forget [...]         Inspect / drop cached memory entries
nexus graph                                  Textual topology: servers → tools, status, memory
nexus dashboard [--port 7531]                Web UI: topology + memory (auto-refresh)
nexus help                                   Show help
```

**Env vars:**

| Var | Purpose |
|---|---|
| `NEXUS_HOME` | Where config + memory live (default `~/.nexus`) |
| `NEXUS_MEMORY` | `0` = disable (memory is ON by default) |
| `OPENAI_API_KEY` | With `NEXUS_EMBEDDING=openai`, uses OpenAI embeddings (optional) |
| `NEXUS_EMBEDDING` | `local` (default, keyless) · `openai` · `hash` (test) |
| `NEXUS_LOG_LEVEL` | `trace`/`debug`/`info`/`warn`/`error` (default `info`) |
| `NEXUS_META_TOOLS` | Set to `1` on `serve` to expose `nexus.*` inspection tools to the client |

> **Logs go to stderr; stdout is reserved for the MCP wire protocol while
> serving.** Don't `console.log` in the serve path.

---

## 5. Adding MCP servers

### From the curated catalog

The catalog ships a few known servers (`memory`, `sequential-thinking`, `github`,
`filesystem`, and a remote template). Extend it at `~/.nexus/catalog.json`.

```bash
nexus add memory                                        # no auth needed
nexus add github --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx
```

If a catalog entry declares required env vars and you don't provide them, `add`
tells you what's missing.

### Freeform (any server)

Use `--` before arguments that start with a dash (like npx's `-y`):

```bash
# Local command-based (stdio)
nexus add mygit --transport stdio --command npx \
  --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx \
  -- -y @modelcontextprotocol/server-github

# Remote (Streamable HTTP)
nexus add remotething --transport streamable-http \
  --url https://example.com/mcp --header Authorization=Bearer xyz

# Remote (SSE)
nexus add legacy --transport sse --url https://example.com/sse
```

Then verify discovery actually worked:

```bash
nexus list-servers
nexus list-tools        # connects to every server and prints the merged manifest
```

---

## 6. Secrets (OS keychain)

Secrets are **encrypted in your OS keychain** (macOS Keychain via `keytar`) and
**never written to `config.json`**.

- `--env K=V` → stored in the keychain (recorded as `secretEnv` in config; the
  value is not on disk).
- `--plain-env K=V` → plaintext in `config.json` (use for non-secrets like a base URL).

At `nexus serve`, each server's `secretEnv` is resolved from the keychain and
injected into the child process's environment. `nexus remove` purges that
server's secrets.

If the OS keychain is unavailable (e.g. headless box without the native module),
`--env` falls back to plaintext config with a warning.

---

## 7. The memory layer

Memory is **opt-in**. Enable it on `nexus serve` with one of:
- `nexus serve` → memory is **ON by default** with **local** embeddings (`bge-small-en-v1.5`, 384-dim), **no API key**; gray-zone verifier uses your client's LLM via MCP sampling. (This is the whole point of Nexus.)
- `NEXUS_MEMORY=0 nexus serve` → disable memory (pure aggregation, no model download).
- `NEXUS_EMBEDDING=openai OPENAI_API_KEY=sk-... nexus serve` → OpenAI embeddings (optional).
- `NEXUS_EMBEDDING=hash nexus serve` → offline deterministic embedder (testing).

### What gets cached

Only **cacheable** tools are cached. Cacheability is derived from each tool's MCP
annotations: `readOnlyHint` or `idempotentHint` → cacheable; `destructiveHint` →
never. Mutating tools (create/update/delete) always go straight through.

### How matching works

1. **Exact args-fingerprint hit** → served from memory instantly (no tool call,
   no embedding). This is the common case and the fast path.
2. Otherwise Nexus embeds the call and runs a nearest-neighbor search:
   - similarity **≥ 0.92** → served (semantic hit)
   - **0.85–0.92** → *gray zone*: the verifier (an LLM check) decides — accept
     serves the cached result, reject refetches. No verifier/key → refetch.
   - **below 0.85** → miss
3. **Miss** → forward to the child; store the result (unless it was an error).

> **Why this is safe:** structurally distinct arguments (e.g. `env:"staging"` vs
> `"production"`) have different fingerprints, so they are separate entries —
> the classic "served the wrong environment's answer" trap is avoided *before*
> similarity is even considered.

### Per-tool freshness (TTL)

By default cached results **never expire** (stable knowledge). Override volatile
tools in `~/.nexus/config.json`:

```jsonc
{
  "ttl": {
    "jira.get_issue": "1d",   // ticket status is good for one day
    "github.*": "12h",        // all tools from the github server
    "*": "30s"                // global fallback
  }
}
```

Precedence: exact `<server>.<tool>` → `<server>.*` → `*` → Infinity. Values are
durations (`30s`, `5m`, `12h`, `1d`, a ms number) or `never`. Expired entries are
refetched on the next call.

### Removing a server

`nexus remove <name>` disconnects the server, drops its tools from the manifest,
**deletes its cached memory entries**, and **purges its keychain secrets**.

---

## 8. Connecting your AI client

Nexus speaks the standard MCP protocol over stdio. Add it as a single MCP server
in your client's config.

**Claude Desktop** (`claude_desktop_config.json`):
```jsonc
{
  "mcpServers": {
    "nexus": {
      "command": "node",
      "args": ["/absolute/path/to/nexus/dist/index.js", "serve"]
    }
  }
}
```

To enable memory, set the env in the client config (Claude Desktop supports an
`"env"` block), or run Nexus under a wrapper that exports `OPENAI_API_KEY`.

**Cursor / other clients:** add Nexus the same way — `command: node`,
`args: [".../dist/index.js", "serve"]`.

Once connected, every tool from every server you added appears under the Nexus
connection, namespaced as `<server>.<tool>`.

---

## 9. Inspecting state

- `nexus list-servers` — what's configured (and enabled/disabled).
- `nexus list-tools` — the live merged tool manifest (also shows which tools are
  cacheable).
- `cat ~/.nexus/config.json` — servers, `secretEnv` names, and TTL rules. Secret
  **values** are not here.
- `~/.nexus/memory.db` — the SQLite memory store (cache entries + embeddings).
  Queryable with any SQLite client.
- `nexus memory stats|list|forget` — browse/purge the cache directly.
- `nexus graph` — textual topology (servers → tools, status, memory counts).
- `nexus dashboard [--port 7531]` — a live web UI of the same (auto-refresh).
- **From the AI client:** set `NEXUS_META_TOOLS=1` on `nexus serve` to expose
  `nexus.memory_stats` / `nexus.memory_list` / `nexus.graph` / `nexus.memory_forget`
  tools, so the model itself can inspect memory and topology.

---

## 10. FAQ / troubleshooting

- **A server doesn't connect.** Run `nexus list-tools`; failures are printed to
  stderr with the server name. Common causes: missing token, wrong `command`,
  the child process crashed (its stderr is surfaced in Nexus logs at `debug`).
- **My token isn't being picked up.** Tokens provided via `--env` live in the
  keychain. If you instead rely on a shell-exported var, Nexus will *not* persist
  it — make sure it's exported in the shell that runs `nexus serve`.
- **Memory doesn't seem to kick in.** Memory is opt-in. Confirm `OPENAI_API_KEY`
  is set (or `NEXUS_EMBEDDING=hash`), and that the tool is cacheable
  (`nexus list-tools` shows `[cacheable]`).
- **Wrong cached answer.** Exact-argument collisions are impossible by
  construction. If you suspect a bad semantic match, lower the gray-zone risk by
  ensuring the verifier is enabled (set `OPENAI_API_KEY`), or set a short TTL for
  that tool.

---

## 11. Current limitations

- **Single-user / local only** — runs as one user on one machine. Not shared.
- **Dashboard is minimal** — `nexus dashboard` shows topology + memory stats
  (read-only, auto-refresh). Adding/removing servers still happens via the CLI.
- **Memory with real embeddings is unit/integration-tested but not yet
  live-validated end-to-end** across many real servers (a gated e2e test exists;
  run it with `OPENAI_API_KEY=… npm test`).
- **Time-sensitivity is manual + opt-in heuristics** — you set TTLs, and
  `ttlHeuristics: true` guesses short TTLs for volatile-looking tool names. There
  is no deeper "this tool is time-sensitive" auto-detection.
- **No "stale + freshness signal"** — expired entries are refetched, not shown
  with an age/freshness note.
- **API-key/token auth only (by design)** — the user provides a key/token
  (`--env` → keychain → injected at spawn), and Nexus uses it as-is. There is
  deliberately **no OAuth flow and no token refresh**; if a credential expires,
  the user re-provides it.
- **Not on npm yet** — the package is publish-ready; run from source today.

---

## 12. Roadmap / Book of Work

Status as of this build:

**Done in v0.1:**
1. ✅ **End-to-end memory validation harness** — gated test; run with
   `OPENAI_API_KEY=… npm test`. Broader multi-server coverage still welcome.
2. ✅ **Time-sensitivity** — per-tool TTL + opt-in heuristics (`ttlHeuristics`).
   Deeper "this tool is time-sensitive" auto-detection is future.
3. ✅ **CLI memory inspection** — `nexus memory stats|list|forget`.
4. 🟡 **Publish to npm** — publish-ready (`files`, `prepublishOnly`, `prepack`).
   Name set: `@likhithreddy/nexus`. **Blocked on:** npm login/account + removing
   `private:true`. See §13.
5. ✅ **Graph** — `nexus graph` textual topology (richer visualization is future).
6. ✅ **See-memory "plugin"** — `nexus.*` meta-tools (`NEXUS_META_TOOLS=1`) let any
   connected client inspect memory/topology.
7. ✅ **Dashboard** — `nexus dashboard` minimal live web UI.
8. ❌ **OAuth** — not doing it. API-key/token only by design.
9. ✅ **Resources + prompts passthrough** — gateway forwards resources
   (URI-routed) and prompts (namespaced).
10. ❌ **Shared/org mode** — out of scope; conflicts with the locked
    local-single-user scope.

**Still open (future):**
- Richer graph/visualization; deeper time-sensitivity auto-detection; a
  "serve-stale + freshness signal" cache mode; an interactive dashboard
  (add/remove servers and manage auth in-browser); broader live e2e coverage.

---

## 13. Publishing to npm

The package name is decided: **`@likhithreddy/nexus`** (scoped under the npm
account `likhithreddy`). The CLI command stays `nexus` via the `bin` field. The
package is still `"private": true` to block an accidental publish until you're
logged in and ready.

To publish (you — needs your npm credentials):

1. **Create/login** — sign up at https://www.npmjs.com/signup as `likhithreddy`
   (or log in if it exists), then `npm login` in this terminal.
2. **Remove `"private": true`** from `package.json` (the name is already set).
3. **Publish** — `npm publish`. `prepublishOnly` runs typecheck + tests + build
   automatically, and `publishConfig.access: "public"` makes the scoped package
   public. `files` ships only `dist/` and `catalog/` (source/tests excluded).

Preview exactly what would be published before pushing:
```bash
npm pack        # builds via prepack and produces a .tgz — inspect its contents
```

Install (once published):
```bash
npm install -g @likhithreddy/nexus
nexus serve
```

---

## 14. Project layout (for contributors)

```
src/
  aggregation/   connectionManager · discovery · namespace · manifest · registry
  config/        schema (zod) · store · catalog · paths
  server/        gateway (tools/resources/prompts + memory) · meta-tools (nexus.*)
  memory/        embeddings · fingerprint · policy · ttl · verifier · store(sqlite+vec) · cache
  secrets/       store.ts — SecretStore + KeychainSecretStore + InMemorySecretStore
  cli/           index (router) · commands (serve/add/list/memory/graph/dashboard/…)
  graph.ts       shared topology renderer (CLI graph + meta-tool + dashboard)
  types.ts · logging.ts · version.ts · index.ts (public API)
catalog/servers.json   curated install specs
tests/                 unit + integration + end-to-end (in-memory + real subprocess)
docs/                  PRD, brainstorm transcript, this guide
```

Key conventions:
- **Logs to stderr only** (stdout is the MCP wire protocol during `serve`).
- `node:sqlite` and `keytar` are loaded via `createRequire` so the bundler
  (tsup/esbuild) doesn't mangle their specifiers.
- Cacheability is a **seam**, not a filter: `isCacheableTool` tags tools for the
  memory layer but every tool is still listed in the manifest.

---

*See `docs/Nexus_MCP_PRD.md` for the original product requirements and design
rationale, and `docs/Nexus_MCP_Chat_Transcript.md` for the brainstorm that
produced it.*
