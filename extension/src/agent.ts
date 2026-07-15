/**
 * Pure agent loop — no vscode import, fully testable.
 * The loop: send messages + tools → collect text + tool calls → execute tools → repeat.
 */

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema?: object;
}

export interface AgentTextPart { type: "text"; text: string }
export interface AgentToolCall { type: "tool-call"; callId: string; name: string; input: unknown }
export type AgentResponsePart = AgentTextPart | AgentToolCall;

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentModel {
  send(messages: AgentMessage[], tools: ToolSpec[]): Promise<{ parts: AgentResponsePart[] }>;
}

export interface AgentBackend {
  callTool(name: string, input: unknown): Promise<{ content: string; isError?: boolean }>;
}

export async function runAgent(args: {
  model: AgentModel;
  backend: AgentBackend;
  system: string;
  userPrompt: string;
  tools: ToolSpec[];
  history?: AgentMessage[];
  maxRounds: number;
  onText: (chunk: string) => void;
}): Promise<{ answer: string; toolsUsed: string[] }> {
  const messages: AgentMessage[] = [];
  if (args.history) messages.push(...args.history);
  messages.push({ role: "user", content: `${args.system}\n\n${args.userPrompt}` });

  const toolsUsed: string[] = [];
  let answer = "";

  for (let round = 0; round < args.maxRounds; round++) {
    const response = await args.model.send(messages, args.tools);
    const textParts = response.parts.filter((p): p is AgentTextPart => p.type === "text");
    const toolCalls = response.parts.filter((p): p is AgentToolCall => p.type === "tool-call");

    // Stream text
    const text = textParts.map((p) => p.text).join("");
    if (text) {
      answer += text;
      args.onText(text);
    }

    // No tool calls → done
    if (toolCalls.length === 0) break;

    // Add assistant message
    const callSummary = toolCalls.map((tc) => tc.name).join(", ");
    messages.push({ role: "assistant", content: text || `(calling tools: ${callSummary})` });

    // Execute tool calls and collect results
    const results: string[] = [];
    for (const tc of toolCalls) {
      try {
        const result = await args.backend.callTool(tc.name, tc.input);
        results.push(`[${tc.name}] ${result.content}`);
        if (!toolsUsed.includes(tc.name)) toolsUsed.push(tc.name);
      } catch (err) {
        results.push(`[${tc.name}] Error: ${(err as Error).message}`);
      }
    }

    // Add user message with tool results
    messages.push({ role: "user", content: results.join("\n\n") });
  }

  return { answer: answer || "(no answer generated)", toolsUsed };
}
