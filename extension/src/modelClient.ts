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

    // VS Code's LanguageModelChatTool only allows [a-zA-Z0-9_-] in tool names.
    // MCP tools are namespaced with dots (e.g. "memory.create_entities").
    // Sanitize dots → double-underscore and keep a lookup map for the reverse.
    const nameMap = new Map<string, string>();
    const vscodeTools: vscode.LanguageModelChatTool[] = tools.map((t) => {
      const sanitized = t.name.replace(/\./g, "__");
      nameMap.set(sanitized, t.name);
      return {
        name: sanitized,
        description: t.description,
        inputSchema: t.inputSchema as object | undefined,
      };
    });

    // Send
    const response = await this.model.sendRequest(vscodeMessages, {
      tools: vscodeTools,
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    });

    // Collect response parts — convert tool call names back to original (dotted)
    const parts: AgentResponsePart[] = [];
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        parts.push({ type: "text", text: part.value });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        const originalName = nameMap.get(part.name) ?? part.name;
        parts.push({ type: "tool-call", callId: part.callId, name: originalName, input: part.input });
      }
    }

    return { parts };
  }
}
