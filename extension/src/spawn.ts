import * as cp from "node:child_process";
import * as vscode from "vscode";

export interface SpawnedBackend {
  port: number;
  host: string;
  token: string;
  baseUrl: string;
  child: cp.ChildProcess;
}

/** Resolve the nexus executable: setting → PATH → npx fallback. */
export function resolveExecutable(setting?: string): { cmd: string; prefixArgs: string[] } {
  if (setting && setting.trim()) {
    return { cmd: setting.trim(), prefixArgs: [] };
  }
  try {
    const isWin = process.platform === "win32";
    const result = cp.spawnSync(isWin ? "where" : "which", ["nexus"], { encoding: "utf-8" });
    if (result.status === 0 && result.stdout.trim()) {
      const path = result.stdout.trim().split("\n")[0]!;
      return { cmd: path, prefixArgs: [] };
    }
  } catch {
    /* ignore */
  }
  return { cmd: "npx", prefixArgs: ["-y", "@likhithreddy/nexus"] };
}

/**
 * Spawn `nexus backend` and wait for the listening event on stdout.
 * The backend prints: {"event":"listening","port":N,"host":"...","token":"..."}
 */
export async function spawnBackend(opts: {
  cmd: string;
  prefixArgs: string[];
  outputChannel: vscode.OutputChannel;
}): Promise<SpawnedBackend> {
  return new Promise((resolve, reject) => {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const args = [...opts.prefixArgs, "backend", "--host", "127.0.0.1", "--token", token];

    opts.outputChannel.appendLine(`[nexus] spawning: ${opts.cmd} ${args.join(" ")}\n`);

    const child = cp.spawn(opts.cmd, args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("backend spawn timed out after 15s — check the Nexus Backend output channel for errors"));
    }, 15_000);

    let stdoutBuf = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      for (const line of stdoutBuf.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          if (evt.event === "listening") {
            clearTimeout(timeout);
            opts.outputChannel.appendLine(`[nexus] backend listening on ${evt.host}:${evt.port}\n`);
            resolve({
              port: evt.port as number,
              host: evt.host as string,
              token: (evt.token as string) ?? token,
              baseUrl: `http://${evt.host}:${evt.port}`,
              child,
            });
            return;
          }
        } catch {
          // Not JSON — could be a log line; forward to output channel
          opts.outputChannel.appendLine(trimmed);
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      opts.outputChannel.append(chunk.toString());
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`backend spawn error: ${err.message}`));
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`backend exited (code ${code}) before signaling ready`));
    });
  });
}
