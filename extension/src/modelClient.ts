import * as vscode from "vscode";
import type { AgentModel, AgentMessage, AgentResponsePart, ToolSpec } from "./agent";

/**
 * Adapter: implements AgentModel using vscode.lm (Copilot's models).
 * Converts AgentMessage[] → LanguageModelChatMessage[], sends to the model,
 * and maps the response stream back to AgentResponsePart[].
 */
export class VscodeLmModel implements AgentModel {
  constructor(
    private model: vscode.LanguageModelChat,
    private token?: vscode.CancellationToken,
  ) {}

  async send(messages: AgentMessage[], tools: ToolSpec[]): Promise<{ parts: AgentResponsePart[] }> {
    // Convert messages
    const vscodeMessages = messages.map((m) =>
      m.role === "user"
        ? vscode.LanguageModelChatMessage.User(m.content)
        : vscode.LanguageModelChatMessage.Assistant(m.content),
    );

    // Convert tools (plain objects matching LanguageModelChatTool interface)
    const vscodeTools: vscode.LanguageModelChatTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as object | undefined,
    }));

    // Send
    const response = await this.model.sendRequest(vscodeMessages, {
      tools: vscodeTools,
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    });

    // Collect response parts
    const parts: AgentResponsePart[] = [];
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        parts.push({ type: "text", text: part.value });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        parts.push({ type: "tool-call", callId: part.callId, name: part.name, input: part.input });
      }
    }

    return { parts };
  }
}
