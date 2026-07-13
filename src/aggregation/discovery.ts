import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Prompt, Resource, Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Call a child server's `tools/list`, following pagination via `nextCursor`
 * until exhausted. Returns the raw (un-namespaced) tools.
 */
export async function discoverTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...res.tools);
    cursor = res.nextCursor;
  } while (cursor);
  return tools;
}

/** Paginated `resources/list`. Returns raw resources (URIs unchanged). */
export async function discoverResources(client: Client): Promise<Resource[]> {
  const out: Resource[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.listResources(cursor ? { cursor } : undefined);
    out.push(...res.resources);
    cursor = res.nextCursor;
  } while (cursor);
  return out;
}

/** Paginated `prompts/list`. Returns raw prompts (names unchanged). */
export async function discoverPrompts(client: Client): Promise<Prompt[]> {
  const out: Prompt[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.listPrompts(cursor ? { cursor } : undefined);
    out.push(...res.prompts);
    cursor = res.nextCursor;
  } while (cursor);
  return out;
}
