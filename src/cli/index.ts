import { parseArgs } from "node:util";
import {
  cmdServe,
  cmdListServers,
  cmdListTools,
  cmdAdd,
  cmdRemove,
  cmdMemory,
  cmdDashboard,
  cmdBackend,
} from "./commands.js";
import { logger } from "../logging.js";
import { VERSION } from "../version.js";

const HELP = `nexus — MCP aggregator with a memory layer

Usage:
  nexus serve                                  Run the MCP gateway over stdio
  nexus list-servers [--json|-j]               Show configured child servers
  nexus list-tools [--json|-j] [--tree]        Connect + show the merged tool manifest (--tree = grouped by server; "nexus graph" is an alias)
  nexus add <catalog-name> [--env K=V]...      Install a server from the curated catalog
  nexus add <name> --transport <t> [...]       Freeform install (stdio/sse/streamable-http)
  nexus remove <name>                          Remove a configured server (+ its keychain secrets)
  nexus memory stats                           Memory: entries + hit/miss counters + hit rate
  nexus memory list [--server S] [--tool T]    Memory: list cached entries (filtered)
  nexus memory show <tool>                     Memory: show full cached result content for a tool
  nexus memory forget [--server S] [--tool T]  Memory: drop cached entries
  nexus dashboard [--port P]                   Web UI: topology + memory on http://localhost:<P> (default 7531)
  nexus help                                   Show this help

Env/secrets on add:
  --env K=V        stored ENCRYPTED in the OS keychain (never written to config)
  --plain-env K=V  plaintext in config (use for non-secret values like base URLs)
  --               everything after is appended verbatim to the server's args

Freeform examples:
  nexus add mygit --transport stdio --command npx -- -y @modelcontextprotocol/server-github --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...
  nexus add remotething --transport streamable-http --url https://example.com/mcp --header Authorization=Bearer xyz

Memory is ON by default when serving (local embeddings, keyless).
Runtime data lives in NEXUS_HOME (default ~/.nexus). Logs go to stderr; stdout is
reserved for the MCP wire protocol when serving.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  // Inspection commands print human output on stdout; keep stderr quiet unless
  // NEXUS_LOG_LEVEL is set or we're serving (serve needs the logs).
  const SERVER_COMMANDS = new Set(["serve", "backend", "dashboard"]);
  if (!(!command || SERVER_COMMANDS.has(command)) && !process.env.NEXUS_LOG_LEVEL) {
    logger.level = "warn";
  }

  switch (command) {
    case "-v":
    case "--version":
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "serve":
      await cmdServe();
      return;
    case "list-servers": {
      const { values } = parseArgs({
        args: rest,
        options: { json: { type: "boolean", short: "j" } },
        allowPositionals: true,
      });
      await cmdListServers(Boolean(values.json));
      return;
    }
    case "list-tools": {
      const { values } = parseArgs({
        args: rest,
        options: { json: { type: "boolean", short: "j" }, tree: { type: "boolean" } },
        allowPositionals: true,
      });
      await cmdListTools({ json: Boolean(values.json), tree: Boolean(values.tree) });
      return;
    }
    case "add":
      await cmdAdd(rest);
      return;
    case "memory":
      await cmdMemory(rest[0], rest.slice(1));
      return;
    case "graph": // alias for list-tools --tree
      await cmdListTools({ tree: true });
      return;
    case "dashboard": {
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: "string", short: "p" } },
        allowPositionals: true,
      });
      await cmdDashboard(values.port ? Number(values.port) : 7531);
      return;
    }
    case "backend": {
      const { values } = parseArgs({
        args: rest,
        options: {
          port: { type: "string", short: "p" },
          host: { type: "string" },
          token: { type: "string" },
        },
        allowPositionals: true,
      });
      await cmdBackend({
        port: values.port ? Number(values.port) : undefined,
        host: values.host,
        token: values.token,
      });
      return;
    }
    case "remove":
    case "rm":
      await cmdRemove(rest[0]);
      return;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
