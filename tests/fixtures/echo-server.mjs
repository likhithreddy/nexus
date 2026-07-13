// A minimal, dependency-light child MCP server for end-to-end validation.
// Run with: node tests/fixtures/echo-server.mjs   (stdio transport)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a message back. Output includes a per-process call counter.",
      inputSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "ping",
      description: "Reply pong.",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    {
      name: "secret",
      description: "Return the NEXUS_TEST_TOKEN env var (validates keychain secret injection).",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
  ],
}));

// Counter increments on every forwarded echo call, so a caller can tell whether
// a repeat call was served from Nexus memory (counter unchanged) or re-forwarded.
let echoCalls = 0;

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params?.name;
  if (name === "echo") {
    echoCalls++;
    const msg = req.params?.arguments?.msg ?? "";
    return { content: [{ type: "text", text: `echo ${echoCalls}: ${String(msg)}` }] };
  }
  if (name === "ping") return { content: [{ type: "text", text: "pong" }] };
  if (name === "secret") {
    return { content: [{ type: "text", text: String(process.env.NEXUS_TEST_TOKEN ?? "(none)") }] };
  }
  return { isError: true, content: [{ type: "text", text: `unknown tool: ${name}` }] };
});

await server.connect(new StdioServerTransport());
