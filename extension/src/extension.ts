import * as vscode from "vscode";
import { BackendManager } from "./backendManager";

let backendMgr: BackendManager;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  backendMgr = new BackendManager(ctx);

  // Register @nexus chat participant
  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
    try {
      const client = await backendMgr.getOrSpawn();

      // Phase 3 will add the full memory-check → LLM loop here.
      // For now, a simple health-check response:
      const health = await client.health();
      stream.markdown(
        `**Nexus backend connected** — ${health.tools} tools from ${health.servers} server(s).\n\n` +
        `*Full chat handler (memory check → Copilot LLM → cache) coming in Phase 3.*`,
      );
    } catch (err) {
      stream.markdown(
        `⚠️ **Nexus backend error:** ${(err as Error).message}\n\n` +
        `Run **"Nexus: Restart Backend"** or check the **Nexus Backend** output channel.`,
      );
    }
  };

  const participant = vscode.chat.createChatParticipant("nexus.chat", handler);
  participant.iconPath = new vscode.ThemeIcon("database");

  // Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand("nexus.restartBackend", async () => {
      try {
        await backendMgr.restart();
        vscode.window.showInformationMessage("Nexus backend restarted.");
      } catch (err) {
        vscode.window.showErrorMessage(`Nexus restart failed: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("nexus.showStats", async () => {
      try {
        const client = await backendMgr.getOrSpawn();
        const stats = await client.stats();
        const qa = (stats as { qa?: { entries: number; hits: number; misses: number } }).qa;
        const qaStr = qa ? `QA cache: ${qa.entries} entries, ${qa.hits} hits, ${qa.misses} misses` : "";
        vscode.window.showInformationMessage(
          `Nexus: ${stats.entries} tool-cache entries · ${qaStr}`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Nexus stats failed: ${(err as Error).message}`);
      }
    }),
  );

  // Status bar
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(database) Nexus";
  statusBarItem.tooltip = "Nexus — MCP assistant with memory";
  statusBarItem.command = "nexus.showStats";
  statusBarItem.show();
  ctx.subscriptions.push(statusBarItem, participant);
}

export async function deactivate(): Promise<void> {
  await backendMgr?.dispose();
}
