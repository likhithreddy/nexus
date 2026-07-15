import * as vscode from "vscode";
import { createHash } from "node:crypto";

export interface WorkspaceContext {
  activeFile?: string;
  languageId?: string;
  selection?: { startLine: number; endLine: number; text: string };
  workspaceRoot?: string;
}

/** Gather workspace context: active file, selection, workspace root. */
export function gatherWorkspaceContext(): WorkspaceContext {
  const editor = vscode.window.activeTextEditor;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const ctx: WorkspaceContext = { workspaceRoot };

  if (editor) {
    ctx.activeFile = editor.document.uri.fsPath;
    ctx.languageId = editor.document.languageId;

    const sel = editor.selection;
    if (!sel.isEmpty) {
      const text = editor.document.getText(sel);
      ctx.selection = {
        startLine: sel.start.line,
        endLine: sel.end.line,
        text: text.length > 4000 ? text.slice(0, 4000) + "\n…(truncated)" : text,
      };
    }
  }

  return ctx;
}

/**
 * Context signature for cache matching: hash of (activeFile, workspaceRoot,
 * selection range). Same file + same selection range → cache hit. Different
 * file/range → miss. Selection TEXT is NOT in the signature (stability).
 * Empty context → "" (global cache, shared across files).
 */
export function contextSignature(ctx: WorkspaceContext): string {
  const parts = [
    ctx.activeFile ?? "",
    ctx.workspaceRoot ?? "",
    ctx.selection ? `${ctx.selection.startLine}-${ctx.selection.endLine}` : "",
  ];
  const joined = parts.join("|");
  if (!joined) return "";
  return createHash("sha256").update(joined).digest("hex").slice(0, 16);
}

/** Build a context block for the system prompt (active file, selection, workspace). */
export function buildContextPrompt(ctx: WorkspaceContext): string {
  const parts: string[] = [];
  if (ctx.workspaceRoot) parts.push(`Workspace: ${ctx.workspaceRoot}`);
  if (ctx.activeFile) parts.push(`Active file: ${ctx.activeFile} (${ctx.languageId ?? "text"})`);
  if (ctx.selection) {
    parts.push(
      `Selected code (lines ${ctx.selection.startLine + 1}-${ctx.selection.endLine + 1}):\n\`\`\`\n${ctx.selection.text}\n\`\`\``,
    );
  }
  return parts.length > 0 ? "\n\n" + parts.join("\n") : "";
}
