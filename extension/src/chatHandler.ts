import * as vscode from "vscode";
import type { BackendManager } from "./backendManager";
import type { BackendClient } from "./backendClient";
import { runAgent, type ToolSpec } from "./agent";
import { VscodeLmModel } from "./modelClient";

const SYSTEM_PROMPT =
  "You are Nexus, an assistant that answers questions using MCP tools. " +
  "Call the relevant tool(s) to get information, then synthesize a clear, concise answer. " +
  "If no tool applies, say so honestly.";

/**
 * The token-savings orchestrator:
 * 1. Check Q&A cache FIRST (0 LLM tokens on a hit).
 * 2. On a miss → run the LLM tool-calling loop via vscode.lm (Copilot).
 * 3. Store the Q+A pair for next time.
 */
export async function handleNexusChat(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  backendMgr: BackendManager,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("nexus");
  const disableCache = config.get<boolean>("disableQaCache", false);
  const maxRounds = config.get<number>("maxToolRounds", 8);

  const client = await backendMgr.getOrSpawn();
  const question = request.prompt;

  // Follow-up turns (history present) bypass cache for safety
  const isFirstTurn = context.history.length === 0;

  // --- Step 1: Memory check (0 tokens on hit) ---
  if (!disableCache && isFirstTurn) {
    try {
      const lookup = await client.qaLookup(question);
      if (lookup.hit && lookup.answer) {
        stream.markdown(lookup.answer);
        stream.markdown("\n\n_— ⚡ served from memory · 0 tokens_");
        return;
      }
    } catch (err) {
      // Cache check failed (backend issue?) — fall through to LLM
      stream.markdown(`_(cache check skipped: ${(err as Error).message})_\n\n`);
    }
  }

  // --- Step 2: LLM loop (miss) ---
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  if (!models.length) {
    stream.markdown("⚠️ **No Copilot model available.** Sign in to GitHub Copilot in VS Code, then try again.");
    return;
  }
  const modelId = config.get<string>("modelId");
  const model = modelId ? models.find((m) => m.id === modelId) ?? models[0]! : models[0]!;

  // Get MCP tools from backend
  const mcpTools = await client.tools();
  const toolSpecs: ToolSpec[] = mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    inputSchema: t.inputSchema as object | undefined,
  }));

  // Run the agent loop
  const agentModel = new VscodeLmModel(model);
  const { answer, toolsUsed } = await runAgent({
    model: agentModel,
    backend: {
      callTool: async (name: string, input: unknown) => {
        const result = await client.callTool(name, input);
        const text = result.content
          .map((c) => c.text ?? JSON.stringify(c))
          .join("\n");
        return { content: text, isError: result.isError };
      },
    },
    system: SYSTEM_PROMPT,
    userPrompt: question,
    tools: toolSpecs,
    maxRounds,
    onText: (chunk) => stream.markdown(chunk),
  });

  // --- Step 3: Store (first turn only) ---
  if (!disableCache && isFirstTurn && answer) {
    try {
      await client.qaStore({ question, answer, toolsUsed });
      stream.markdown("\n\n_— cached for next time_");
    } catch {
      // Store failed — non-fatal; the answer was already streamed
    }
  }
}
