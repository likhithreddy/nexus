# Nexus — Testing Guide (as an end user)

Follow this to install, use, and stress-test the published package, then report
back. Assumes the package is published as **`@likhithreddy/nexus`** (CLI command
`nexus`).

> If `npm i -g @likhithreddy/nexus` returns a 404, it isn't published yet — run
> `npm publish` in the project first, then come back here.

---

## 0. Install

```bash
npm install -g @likhithreddy/nexus
which nexus            # should print a path
nexus help             # prints the command list
npm ls -g @likhithreddy/nexus   # confirms the installed version
```

Nexus keeps everything under `~/.nexus` (`config.json`, `memory.db`, keychain
secrets). No other setup.

---

## 1. Smoke test (no AI client needed)

Add a read-only server from the catalog and confirm discovery works:

```bash
nexus add memory                         # knowledge-graph MCP; no auth needed
nexus list-servers                       # shows `fetch`
nexus list-tools                         # connects to `fetch` and prints its tools
nexus graph                              # topology tree (● connected, tools, cacheable markers)
```

`list-tools` actually spawns the child server via `npx`, so if you see its tools
listed, the whole aggregation path works. If it errors, note the stderr message.

---

## 2. Add the MCP servers you actually use

**From the catalog** (tokens go to the OS keychain, never written to config):
```bash
nexus add github --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx
```

**Freeform local server** (use `--` before dash-leading args like npx's `-y`):
```bash
nexus add mygit --transport stdio --command npx \
  --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx \
  -- -y @modelcontextprotocol/server-github
```

**Remote server** (Streamable HTTP or SSE):
```bash
nexus add acme --transport streamable-http --url https://example.com/mcp \
  --header Authorization=Bearer xyz
```

Non-secret values use `--plain-env K=V` (goes into config as plaintext). Verify:
```bash
nexus list-servers
nexus list-tools          # everything merged, namespaced as <server>.<tool>
cat ~/.nexus/config.json  # secrets NOT present — only `secretEnv` names
```

Remove one with `nexus remove <name>` (also purges its keychain secrets + cached
memory).

---

## 3. Use it as an MCP server (the main event)

`nexus serve` speaks MCP over stdio. Point your AI client at it as a **single**
MCP server.

**Claude Desktop** — edit `claude_desktop_config.json`:
```jsonc
{
  "mcpServers": {
    "nexus": { "command": "npx", "args": ["-y", "@likhithreddy/nexus", "serve"] }
  }
}
```
(Or, with the global install, use the absolute path: `command": "/usr/local/bin/nexus"`,
`"args": ["serve"]` — find it with `which nexus`.)

**Cursor / other clients** — same shape: `command: npx`, `args: ["-y", "@likhithreddy/nexus", "serve"]`.

Restart the client. Every tool from every server you added should appear under
the Nexus connection, namespaced (`jira.get_issue`, `github.search`, …). Ask the
AI to use one and watch it route.

---

## 4. Turn on memory (optional, the cost/latency win)

Memory needs an embeddings provider. Run serve with a key:
```bash
OPENAI_API_KEY=sk-... nexus serve
```
(For Claude Desktop, put `OPENAI_API_KEY` in that server's `"env"` block.)

Now ask the AI the same cacheable question twice. The second time it should be
served from memory (no tool call). Confirm:
```bash
nexus memory stats        # entry count + per-server breakdown
nexus memory list         # what's cached
nexus dashboard           # http://localhost:7531 — live web UI (auto-refresh)
```

Or let the AI inspect memory itself — serve with `NEXUS_META_TOOLS=1` and the
client gains `nexus.memory_stats`, `nexus.memory_list`, `nexus.graph`,
`nexus.memory_forget` tools.

---

## 5. Debugging knobs

- `NEXUS_LOG_LEVEL=debug nexus serve` — verbose decisions to **stderr**
  (stdout stays the MCP wire protocol; don't pipe it).
- `nexus graph` / `nexus dashboard` — see what's connected and what's cached.
- A child server's own stderr is surfaced in Nexus logs at `debug`.
- `nexus memory forget --server <name>` — wipe a server's cache to re-test.

---

## 6. What to report back (feedback template)

For each issue, send:
1. **Command + exact output / error** (stderr included).
2. **What you expected vs. what happened.**
3. **Version:** `npm ls -g @likhithreddy/nexus`.
4. **OS / Node:** `node -v`.
5. **Relevant config** (redact secrets): the server entry from
   `~/.nexus/config.json` (without values).

Particularly useful to validate:
- Install + `nexus help` works cleanly from the published package.
- A catalog server and a freeform server both discover tools.
- A real AI client (Claude Desktop/Cursor) sees the merged tools and can call
  them.
- Memory: a repeat call is served from cache (counter/memory stats unchanged).
- Dashboard renders; `nexus memory` commands work while serve is running.
- Secrets are absent from `config.json` and present in the keychain.

---

*See `docs/Nexus_Guide.md` for the full reference (CLI, memory, secrets,
roadmap).*
