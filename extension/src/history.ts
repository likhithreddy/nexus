import * as vscode from "vscode";
import type { AgentMessage } from "./agent";

/**
 * Map VS Code chat history (previous turns in the thread) to agent messages
 * for follow-up support. Includes all turns in the thread (user questions +
 * assistant responses), preserving order.
 */
export function toAgentHistory(
  history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>,
): AgentMessage[] {
  const messages: AgentMessage[] = [];

  for (const turn of history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push({ role: "user", content: turn.prompt });
    } else if (turn instanceof vscode.ChatResponseTurn) {
      let text = "";
      for (const part of turn.response) {
        if (part instanceof vscode.ChatResponseMarkdownPart) {
          text += part.value.value;
        }
      }
      if (text) messages.push({ role: "assistant", content: text });
    }
  }

  return messages;
}
