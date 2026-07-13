import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { InMemorySecretStore, resolveSecretEnv } from "../src/secrets/store.js";
import { loadConfig } from "../src/config/store.js";
import { cmdAdd, cmdRemove } from "../src/cli/commands.js";

let home: string;
const store = new InMemorySecretStore();

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-sec-"));
  process.env.NEXUS_HOME = home;
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  delete process.env.NEXUS_HOME;
});

describe("secret storage", () => {
  it("resolveSecretEnv returns only the stored values", async () => {
    await store.set("srv", "TOKEN", "abc");
    expect(await resolveSecretEnv(store, "srv", ["TOKEN", "MISSING"])).toEqual({ TOKEN: "abc" });
  });

  it("deleteServer removes all of a server's secrets but leaves others", async () => {
    await store.set("srv", "A", "1");
    await store.set("srv", "B", "2");
    await store.set("other", "A", "3");
    await store.deleteServer("srv");
    expect(await store.get("srv", "A")).toBeUndefined();
    expect(await store.get("srv", "B")).toBeUndefined();
    expect(await store.get("other", "A")).toBe("3");
  });

  it("cmdAdd stores --env in the keychain and keeps it out of config.json", async () => {
    await cmdAdd(
      [
        "mygit", "--transport", "stdio", "--command", "npx",
        "--env", "TOKEN=secret123",
        "--plain-env", "BASE_URL=https://x",
        "--", "-y", "pkg",
      ],
      { secretStore: store },
    );

    const config = await loadConfig();
    const srv = config.servers.find((s) => s.name === "mygit");
    expect(srv?.secretEnv).toEqual(["TOKEN"]);
    expect(srv?.env).toEqual({ BASE_URL: "https://x" }); // no secret value in config
    expect(JSON.stringify(config.servers)).not.toContain("secret123");
    expect(await store.get("mygit", "TOKEN")).toBe("secret123");
    expect(srv?.args).toEqual(["-y", "pkg"]); // args after `--` preserved
  });

  it("cmdRemove purges a server's keychain secrets", async () => {
    await cmdAdd(["s", "--transport", "stdio", "--command", "npx", "--env", "K=v"], {
      secretStore: store,
    });
    expect(await store.get("s", "K")).toBe("v");

    await cmdRemove("s", { secretStore: store });
    expect(await store.get("s", "K")).toBeUndefined();
  });
});
