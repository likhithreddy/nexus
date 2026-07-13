import { createRequire } from "node:module";
import { logger } from "../logging.js";

/**
 * Encrypted secret storage (PRD §12). Secrets are never written to config.json;
 * they live in the OS keychain and are resolved into the child's spawn env at
 * connect time.
 *
 * `SecretStore` is the seam; `KeychainSecretStore` is the production impl
 * (keytar via the OS keychain), `InMemorySecretStore` is for tests.
 */

export interface SecretStore {
  get(serverName: string, envVar: string): Promise<string | undefined>;
  set(serverName: string, envVar: string, value: string): Promise<void>;
  delete(serverName: string, envVar: string): Promise<void>;
  /** Remove every secret stored for this server (on `nexus remove`). */
  deleteServer(serverName: string): Promise<void>;
}

export const KEYCHAIN_SERVICE = "nexus";
const accountKey = (server: string, envVar: string) => `${server}/${envVar}`;

/** Resolve a server's secretEnv names into a { name: value } map. */
export async function resolveSecretEnv(
  store: SecretStore,
  serverName: string,
  names: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = await store.get(serverName, name);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

// keytar is a CJS native addon; load it through createRequire so bundlers don't
// try to rewrite/inline it (same approach as node:sqlite).
interface KeytarApi {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | undefined>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<{ account: string; password: string }[]>;
}
function loadKeytar(): KeytarApi | undefined {
  try {
    return createRequire(import.meta.url)("keytar") as KeytarApi;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "keytar unavailable; secrets fall back to plaintext config");
    return undefined;
  }
}

export class KeychainSecretStore implements SecretStore {
  private api: KeytarApi | undefined = loadKeytar();
  /** True if the OS keychain backend loaded. */
  get available(): boolean {
    return this.api !== undefined;
  }

  async get(serverName: string, envVar: string): Promise<string | undefined> {
    return this.api?.getPassword(KEYCHAIN_SERVICE, accountKey(serverName, envVar));
  }
  async set(serverName: string, envVar: string, value: string): Promise<void> {
    if (!this.api) throw new Error("keychain backend unavailable");
    await this.api.setPassword(KEYCHAIN_SERVICE, accountKey(serverName, envVar), value);
  }
  async delete(serverName: string, envVar: string): Promise<void> {
    await this.api?.deletePassword(KEYCHAIN_SERVICE, accountKey(serverName, envVar));
  }
  async deleteServer(serverName: string): Promise<void> {
    if (!this.api) return;
    const prefix = `${serverName}/`;
    const creds = await this.api.findCredentials(KEYCHAIN_SERVICE);
    for (const c of creds) {
      if (c.account.startsWith(prefix)) await this.api.deletePassword(KEYCHAIN_SERVICE, c.account);
    }
  }
}

/** Process-wide default store: the keychain if keytar loaded, else undefined. */
export function getDefaultSecretStore(): SecretStore | undefined {
  const store = new KeychainSecretStore();
  return store.available ? store : undefined;
}

/** In-memory store for tests. */
export class InMemorySecretStore implements SecretStore {
  private map = new Map<string, string>();
  async get(serverName: string, envVar: string): Promise<string | undefined> {
    return this.map.get(accountKey(serverName, envVar));
  }
  async set(serverName: string, envVar: string, value: string): Promise<void> {
    this.map.set(accountKey(serverName, envVar), value);
  }
  async delete(serverName: string, envVar: string): Promise<void> {
    this.map.delete(accountKey(serverName, envVar));
  }
  async deleteServer(serverName: string): Promise<void> {
    const prefix = `${serverName}/`;
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }
}
