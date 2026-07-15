import * as vscode from "vscode";
import { spawnBackend, resolveExecutable, type SpawnedBackend } from "./spawn";
import { BackendClient } from "./backendClient";

/**
 * Manages the Nexus backend subprocess lifecycle: lazy spawn on first use,
 * health checks, respawn on crash, graceful shutdown.
 */
export class BackendManager {
  private spawned: SpawnedBackend | undefined;
  private client: BackendClient | undefined;
  private outputChannel: vscode.OutputChannel;

  constructor(private ctx: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel("Nexus Backend");
    ctx.subscriptions.push(this.outputChannel);
  }

  /** Get a healthy client, spawning the backend if needed. */
  async getOrSpawn(): Promise<BackendClient> {
    // Fast path: existing client is healthy
    if (this.client && this.spawned) {
      try {
        await this.client.health();
        return this.client;
      } catch {
        this.outputChannel.appendLine("[nexus] backend health check failed — respawning\n");
        this.killChild();
      }
    }

    // Spawn
    const setting = vscode.workspace.getConfiguration("nexus").get<string>("executablePath");
    const { cmd, prefixArgs } = resolveExecutable(setting);

    this.spawned = await spawnBackend({ cmd, prefixArgs, outputChannel: this.outputChannel });
    this.client = new BackendClient(this.spawned.baseUrl, this.spawned.token);

    // Monitor for unexpected exit
    this.spawned.child.on("exit", (code) => {
      this.outputChannel.appendLine(`[nexus] backend exited (code ${code})\n`);
      this.spawned = undefined;
      this.client = undefined;
    });

    return this.client;
  }

  /** Kill and re-spawn the backend. */
  async restart(): Promise<BackendClient> {
    this.killChild();
    return this.getOrSpawn();
  }

  /** Kill the child process if it exists. */
  private killChild(): void {
    if (this.spawned) {
      try {
        this.spawned.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.spawned = undefined;
      this.client = undefined;
    }
  }

  dispose(): void {
    this.killChild();
  }
}
