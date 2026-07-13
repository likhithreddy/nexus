# Nexus — Command Handbook

The complete reference for the published **`@likhithreddy/nexus`** package (CLI
command: `nexus`). Every command, flag, transport, and auth option, with copy-
paste examples.

> Scope: Nexus is a **local, single-user** MCP aggregator + memory layer. Auth
> is **API-key/token only** (you provide the key; Nexus injects it). No OAuth,
> no token refresh.

---

## 1. Install

```bash
npm install -g @likhithreddy/nexus
nexus help
```

All state lives under `NEXUS_HOME` (default `~/.nexus`): `config.json`,
`memory.db`, and keychain secrets.

---

## 2. Two ways to use Nexus

| Mode | What it is | When |
|---|---|---|
| **As a CLI** | Run `nexus` commands directly (add/list/inspect) | Setup, debugging, browsing memory |
| **As an MCP server** | Run `nexus serve`; an AI client connects to it over stdio | Real use — your AI assistant calls all your tools through Nexus |

You can mix both: configure with the CLI, then run `serve` for the AI client.

---

## 3. Command reference

### `nexus serve`
Runs the MCP gateway over stdio (point an MCP client at this).
```bash
nexus serve
nexus serve                                 # memory ON by default (local embeddings, keyless)
NEXUS_MEMORY=0 nexus serve                  # disable memory (pure aggregation, no model download)
NEXUS_EMBEDDING=openai OPENAI_API_KEY=sk-... nexus serve   # OpenAI embeddings (optional)
NEXUS_META_TOOLS=1 nexus serve              # expose nexus.* inspection tools to the client
NEXUS_LOG_LEVEL=debug nexus serve           # verbose decisions to stderr
```
Logs go to **stderr**; stdout is the MCP wire protocol (don't pipe it).

### `nexus list-servers [--json|-j]`
Show configured child servers.
```bash
nexus list-servers
nexus list-servers --json
```

### `nexus list-tools [--json|-j]`
Connects to every configured server **live** and prints the merged, namespaced
tool manifest (also shows `[cacheable]` markers). The quickest way to confirm
discovery works.
```bash
nexus list-tools
nexus list-tools --json
```

### `nexus add` — install a server (two forms)

**Form A — from the catalog:**
```bash
nexus add <catalog-name> [--env K=V]... [--plain-env K=V]...
```
**Form B — freeform:**
```bash
nexus add <name> --transport <t> [options...]
```

**All `add` flags:**

| Flag | Type | Purpose |
|---|---|---|
| `--transport`, `-t` | string | `stdio` \| `sse` \| `streamable-http` (required for freeform) |
| `--command` | string | Executable to run (stdio only) |
| `--args` | string, repeatable | Args for the command (use `--` for dash-leading ones) |
| `--url` | string | Remote URL (sse / streamable-http) |
| `--env` | string, repeatable | `KEY=VALUE` → stored **encrypted in the keychain** (secrets) |
| `--plain-env` | string, repeatable | `KEY=VALUE` → plaintext in config (non-secrets, e.g. base URLs) |
| `--header` | string, repeatable | `KEY=VALUE` or `KEY:VALUE` → HTTP header (remote) |
| `--authType` | string | `none` \| `api_key` (default `none`; `oauth` is rejected) |
| `--disable` | boolean | Add the server but leave it disabled |
| `--` | separator | Everything after `--` is appended verbatim to `--args` |

### `nexus remove <name>`  (alias: `nexus rm <name>`)
Disconnects the server, removes its tools, **deletes its cached memory**, and
**purges its keychain secrets**.
```bash
nexus remove github
```

### `nexus memory <subcommand>` — inspect the cache (no `serve` needed)
```bash
nexus memory stats                                   # entry count + per-server
nexus memory list [--server S] [--tool T] [--limit N]
nexus memory forget [--server S] [--tool T]          # drop cached entries
```

### `nexus graph`
Live textual topology: each server → its tools (with `[cacheable]`), connection
status (`●` connected / `○` disabled / `✕` failed), and cached-entry counts.

### `nexus dashboard [--port|-p <N>]`
Serves a live web UI (topology + memory, auto-refresh) on
`http://localhost:<port>` (default `7531`). Ctrl-C to stop.

### `nexus help`
Show help. (`-h`, `--help`, or no args also show it.)

---

## 4. Adding MCP servers — every method

### 4.1 From the catalog (simplest)
```bash
nexus add memory                      # no auth
nexus add sequential-thinking         # no auth
nexus add github --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx
```
Catalog entries ship with `memory`, `sequential-thinking`, `github`,
`filesystem`, and an `example-remote` template. Extend the catalog at
`~/.nexus/catalog.json`.

### 4.2 Freeform **stdio** (local command)
```bash
nexus add fs --transport stdio --command npx \
  --args -y --args @modelcontextprotocol/server-filesystem --args /Users/you/docs
```

### 4.3 Freeform **stdio** with `npx` and dash-leading args (use `--`)
`-y` would otherwise look like a flag, so put it after `--`:
```bash
nexus add mygit --transport stdio --command npx \
  --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx \
  -- -y @modelcontextprotocol/server-github
```
Everything after `--` becomes args verbatim.

### 4.4 Remote **Streamable HTTP**
```bash
nexus add acme --transport streamable-http \
  --url https://mcp.example.com/mcp \
  --header Authorization=Bearer xyz
```

### 4.5 Remote **SSE**
```bash
nexus add legacy --transport sse --url https://mcp.example.com/sse
```

### 4.6 Auth — three places a key can go
- **`--env KEY=VAL`** → encrypted keychain; injected into the child's **env** at
  spawn. Use for stdio servers' tokens (e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`).
  Never written to `config.json`.
- **`--plain-env KEY=VAL`** → plaintext in `config.json`, injected into the
  child env. Use for non-secrets (e.g. `JIRA_BASE_URL`).
- **`--header KEY=VAL`** → HTTP header on remote (sse / streamable-http)
  requests. Use for `Authorization=Bearer ...` etc.
- **`--authType api_key`** → metadata marker (doesn't change behavior; documents
  that this server uses a key).

Catalog entries with `requiredEnv` are validated: a required var must be
provided via `--env`, `--plain-env`, **or** already exported in your shell —
otherwise `add` errors and tells you what's missing.

### 4.7 OAuth — not supported (by design)
`--authType oauth` is rejected. The user creates the API key on the MCP server's
own platform and hands it to Nexus; Nexus never runs an OAuth flow or refreshes
tokens. If a key expires, the child server returns an auth error and you
re-create the key.

### 4.8 Add disabled
```bash
nexus add heavy --transport stdio --command node --args ./heavy-mcp.js --disable
```
Listed but skipped at `serve`/`list-tools`. Re-enable by editing `config.json`
(`"enabled": true`).

---

## 5. Secrets (OS keychain)

- `--env` values are stored in the **OS keychain** (macOS Keychain via `keytar`),
  recorded in `config.json` only as `secretEnv` **names** — values never on disk.
- At `nexus serve`, each server's `secretEnv` is resolved from the keychain and
  injected into the child process env.
- `nexus remove` purges that server's secrets.
- If the keychain is unavailable (e.g. headless box), `--env` falls back to
  plaintext config with a warning.

Verify nothing leaked:
```bash
cat ~/.nexus/config.json     # secrets absent — only secretEnv names appear
```

---

## 6. Using Nexus as an MCP server (the main use)

`nexus serve` speaks MCP over stdio. Add it to your client as a **single** MCP
server; every server you configured appears under it, namespaced `<server>.<tool>`.

**Claude Desktop** (`claude_desktop_config.json`):
```jsonc
{
  "mcpServers": {
    "nexus": { "command": "npx", "args": ["-y", "@likhithreddy/nexus", "serve"] }
  }
}
```
With memory + meta-tools:
```jsonc
{
  "mcpServers": {
    "nexus": {
      "command": "npx",
      "args": ["-y", "@likhithreddy/nexus", "serve"],
      "env": { "OPENAI_API_KEY": "sk-...", "NEXUS_META_TOOLS": "1" }
    }
  }
}
```

**Cursor / generic clients** — same shape: `command: "npx"`,
`args: ["-y", "@likhithreddy/nexus", "serve"]`. (Or, with the global install, use
the absolute path from `which nexus` with `args: ["serve"]`.)

Tools, **resources**, and **prompts** from child servers are all merged and
forwarded. Restart the client after editing config.

---

## 7. The memory layer

**On by default** — `nexus serve` activates memory with a **local** embedding
model (`bge-small-en-v1.5`), **no API key needed**; the gray-zone verifier asks
your client's LLM via MCP sampling (harness-driven). Opt out with
`NEXUS_MEMORY=0` (pure aggregation, no model download). Prefer OpenAI?
`NEXUS_EMBEDDING=openai OPENAI_API_KEY=sk-... nexus serve`. (`NEXUS_EMBEDDING=hash`
= offline deterministic embedder for testing.)

**What gets cached:** only **cacheable** tools — `readOnlyHint`/`idempotentHint`
and not `destructiveHint` (derived from each tool's MCP annotations). Mutating
tools always go straight through.

**How a call resolves:**
1. **Exact args-fingerprint hit** → served instantly (no tool call, no embedding).
2. Else embed + nearest-neighbor: **≥0.92** serve (semantic hit) · **0.85–0.92**
   gray zone → verifier decides (accept serves, reject refetches) · **<0.85** miss.
3. **Miss** → forward to child; store the result if it wasn't an error.

**Per-tool TTL** (`~/.nexus/config.json`):
```jsonc
{ "ttl": { "jira.get_issue": "1d", "github.*": "12h", "*": "30s" } }
```
Precedence: exact `<server>.<tool>` → `<server>.*` → `*` → Infinity. Values:
`30s` / `5m` / `12h` / `1d` / ms number / `never`.

**Auto time-sensitivity (opt-in):**
```jsonc
{ "ttlHeuristics": true, "heuristicTtlMs": "5m" }
```
Infer a short TTL for volatile-looking tool names (`status`, `current`, `now`,
`logs`, `ci`, …). Explicit TTLs always win.

**Inspect:** `nexus memory stats|list`, `nexus graph`, `nexus dashboard`, or —
with `NEXUS_META_TOOLS=1` — the AI client can call `nexus.memory_stats`,
`nexus.memory_list`, `nexus.graph`, `nexus.memory_forget` directly.

---

## 8. Environment variables

| Var | Default | Purpose |
|---|---|---|
| `NEXUS_HOME` | `~/.nexus` | Where config + memory live |
| `NEXUS_MEMORY` | on | `0` = disable (memory is ON by default) |
| `NEXUS_EMBEDDING` | `local` | `local` (default, keyless) · `openai` (needs `OPENAI_API_KEY`) · `hash` (test) |
| `OPENAI_API_KEY` | — | Only with `NEXUS_EMBEDDING=openai` |
| `NEXUS_HIT_THRESHOLD` / `NEXUS_GRAY_LOW` | `0.85` / `0.70` | Semantic hit / gray-zone thresholds (raise to 0.92/0.85 for OpenAI) |
| `NEXUS_META_TOOLS` | — | `1` = expose `nexus.*` inspection tools to the client |
| `NEXUS_LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error` |

---

## 9. Config file (`~/.nexus/config.json`)

```jsonc
{
  "version": 1,
  "servers": [
    {
      "name": "github",                 // slug; also the tool namespace prefix
      "transport": "stdio",             // stdio | sse | streamable-http
      "enabled": true,
      "command": "npx",                 // stdio
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {},                        // plaintext non-secret env
      "secretEnv": ["GITHUB_PERSONAL_ACCESS_TOKEN"],  // names → keychain
      "url": undefined,                 // sse | streamable-http
      "headers": {},                    // remote headers
      "authType": "api_key",            // none | api_key
      "requiredEnv": [],
      "addedAt": "2026-..."
    }
  ],
  "ttl": { "github.*": "12h" },
  "ttlHeuristics": false,
  "heuristicTtlMs": "5m"
}
```
You usually don't edit this by hand — `nexus add`/`remove` manage it.

---

## 10. File locations

| Path | Contents |
|---|---|
| `~/.nexus/config.json` | Servers, TTL rules (no secret values) |
| `~/.nexus/memory.db` | SQLite + sqlite-vec memory store |
| `~/.nexus/catalog.json` | Optional catalog overrides |
| OS keychain | Encrypted secret values (`nexus/<server>/<VAR>`) |

---

## 11. Tips & troubleshooting

- **`--` before dash args:** `nexus add x --command npx -- -y @pkg`.
- **stdout vs stderr:** never pipe `nexus serve` stdout; logs are on stderr.
- **A server won't connect:** run `nexus list-tools`; errors print to stderr with
  the server name. Common: missing token, wrong command, child crashed
  (`NEXUS_LOG_LEVEL=debug` shows child stderr).
- **Token not picked up:** `--env` secrets live in the keychain; if you relied on
  a shell export instead, it isn't persisted — re-add with `--env`.
- **Memory not caching:** confirm `OPENAI_API_KEY` (or `NEXUS_EMBEDDING=hash`)
  and that the tool is `cacheable` (`nexus list-tools` shows `[cacheable]`).
- **Wrong cached answer:** exact-arg collisions are impossible by design; for a
  suspicious semantic match, enable the verifier (set `OPENAI_API_KEY`) or set a
  short TTL, then `nexus memory forget --tool <name>`.

---

## 12. Publishing (reference — you run this)

```bash
npm login                                  # one time (already done)
npm publish --otp=123456                   # 6-digit authenticator code (2FA on)
npm view @likhithreddy/nexus version       # confirm: 0.1.0
npm install -g @likhithreddy/nexus && nexus help
```
Later versions: `npm version patch && npm publish --otp=123456`.
`prepublishOnly` auto-runs typecheck + tests + build; `files` ships only
`dist/`, `catalog/`, README, and `package.json`.

---

*Companion docs: `docs/Nexus_Guide.md` (concepts + roadmap) and
`docs/Testing_Guide.md` (how to test).*
