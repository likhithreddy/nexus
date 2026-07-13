import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getDefaultSecretStore, KeychainSecretStore } from "../src/secrets/store.js";

const REPO = process.cwd();
const DIST = path.join(REPO, "dist", "index.js");
const FIXTURE = path.join(REPO, "tests", "fixtures", "echo-server.mjs");

let nexusHome: string;

beforeAll(async () => {
  // Ensure the shipped binary is present (build if missing).
  try {
    await fs.access(DIST);
  } catch {
    execFileSync("npm", ["run", "build"], { cwd: REPO, stdio: "inherit" });
  }
  nexusHome = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-e2e-"));
  const config = {
    version: 1,
    servers: [{ name: "echo", transport: "stdio" as const, command: "node", args: [FIXTURE] }],
  };
  await fs.writeFile(path.join(nexusHome, "config.json"), JSON.stringify(config, null, 2));
}, 60_000);

afterAll(async () => {
  if (nexusHome) await fs.rm(nexusHome, { recursive: true, force: true });
});

function textOf(r: CallToolResult): string {
  const first = r.content[0];
  return first && "text" in first ? first.text : "";
}

function baseEnv(): Record<string, string> {
  // Strip OPENAI_API_KEY so memory defaults to OFF unless a test opts in.
  const env = { ...process.env, NEXUS_HOME: nexusHome } as Record<string, string>;
  delete env.OPENAI_API_KEY;
  delete env.NEXUS_EMBEDDING;
  env.NEXUS_MEMORY = "0"; // memory is ON by default; disable for pure-aggregation tests
  return env;
}

async function withClient(
  env: Record<string, string>,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({ command: "node", args: [DIST, "serve"], env });
  const client = new Client({ name: "e2e-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

/**
 * Black-box validation of `nexus serve`: spawns the real built binary as a
 * subprocess and connects a real MCP client over stdio (the Claude Desktop path).
 */
describe("nexus serve (real subprocess over stdio)", () => {
  it("aggregation: merged namespaced tools + forwarding (memory off)", async () => {
    await withClient(baseEnv(), async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(["echo.echo", "echo.ping", "echo.secret"]);

      expect(
        textOf(await client.callTool({ name: "echo.echo", arguments: { msg: "hi" } }) as CallToolResult),
      ).toBe("echo 1: hi");
      expect(
        textOf(await client.callTool({ name: "echo.ping", arguments: {} }) as CallToolResult),
      ).toBe("pong");
    });
  }, 30_000);

  it("memory: a repeat cacheable call is served from memory (child not re-invoked)", async () => {
    // NEXUS_EMBEDDING=hash enables the memory layer offline (no network/key).
    const env = { ...baseEnv(), NEXUS_EMBEDDING: "hash", NEXUS_MEMORY: "1" };
    await withClient(env, async (client) => {
      const first = textOf(
        await client.callTool({ name: "echo.echo", arguments: { msg: "x" } }) as CallToolResult,
      );
      const second = textOf(
        await client.callTool({ name: "echo.echo", arguments: { msg: "x" } }) as CallToolResult,
      );
      // First call forwards to the child (fixture counter -> 1). If the repeat
      // call is served from memory, the child is NOT re-invoked, so the counter
      // stays 1 and the output is identical. Without memory it would be "echo 2: x".
      expect(first).toBe("echo 1: x");
      expect(second).toBe("echo 1: x");
    });
  }, 30_000);

  it.skipIf(process.platform !== "darwin" || !getDefaultSecretStore())("secrets: a keychain-stored env var reaches the child at spawn", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-secret-"));
    const store = new KeychainSecretStore();
    try {
      await store.set("echo", "NEXUS_TEST_TOKEN", "ovaltine");
      const config = {
        version: 1,
        servers: [
          { name: "echo", transport: "stdio" as const, command: "node", args: [FIXTURE], secretEnv: ["NEXUS_TEST_TOKEN"] },
        ],
      };
      await fs.writeFile(path.join(home, "config.json"), JSON.stringify(config));

      const env = { ...process.env, NEXUS_HOME: home, NEXUS_MEMORY: "0" } as Record<string, string>;
      delete env.OPENAI_API_KEY;
      delete env.NEXUS_EMBEDDING;
      await withClient(env, async (client) => {
        const r = textOf(await client.callTool({ name: "echo.secret", arguments: {} }) as CallToolResult);
        expect(r).toBe("ovaltine"); // secret was resolved from the keychain into the child env
      });
    } finally {
      await store.deleteServer("echo").catch(() => {});
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  // E2E memory validation with REAL OpenAI embeddings. Skipped unless the user
  // runs the suite with OPENAI_API_KEY set: `OPENAI_API_KEY=sk-... npm test`.
  // Proves the live embedding path works through the subprocess: a repeat
  // cacheable call is served from memory (the child's counter stays at 1).
  it.skipIf(!process.env.OPENAI_API_KEY)("memory (real OpenAI embeddings): repeat call served from cache", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-meme2e-"));
    try {
      const config = {
        version: 1,
        servers: [{ name: "echo", transport: "stdio" as const, command: "node", args: [FIXTURE] }],
      };
      await fs.writeFile(path.join(home, "config.json"), JSON.stringify(config));
      // OPENAI_API_KEY inherited from process.env → memory ON; force the OpenAI
      // provider (default would be local) so this really tests OpenAI embeddings.
      const env = { ...process.env, NEXUS_HOME: home, NEXUS_EMBEDDING: "openai", NEXUS_MEMORY: "1" } as Record<string, string>;
      await withClient(env, async (client) => {
        const first = textOf(await client.callTool({ name: "echo.echo", arguments: { msg: "real" } }) as CallToolResult);
        const second = textOf(await client.callTool({ name: "echo.echo", arguments: { msg: "real" } }) as CallToolResult);
        expect(first).toBe("echo 1: real");
        expect(second).toBe("echo 1: real"); // exact hit → child not re-invoked
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
