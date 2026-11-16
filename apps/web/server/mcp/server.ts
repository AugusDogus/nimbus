import {
  McpServer,
  requireScopes,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import type { McpToolContext } from "@nimbus/api/mcp-tool";
import { mcpTools } from "@nimbus/api/mcp-tools";

const instructions = [
  "Nimbus is the user's self-hosted file drive. You act as the signed-in user, with their file permissions.",
  'Paths are relative to the drive root and use "/" separators; "" is the root. Start with list_folder or search_files.',
  "Read files in ranges with read_text. Before replacing a file, read it or call get_item and pass its etag as expectedEtag.",
  "Moves, renames, trashing, public links, and permission changes affect other people's access. Confirm them with the user first.",
].join("\n");

/** A fresh MCP server whose tools act as one verified connection. */
export function createNimbusMcpServer(context: McpToolContext) {
  const server = new McpServer(
    { name: "nimbus", title: "Nimbus", version: "1.0.0" },
    { instructions },
  );
  for (const tool of mcpTools)
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
        annotations: { title: tool.title, ...tool.annotations },
        // Lets the HTTP layer answer 403 insufficient_scope so clients can ask for more access.
        scopeChallenge: requireScopes(tool.scope),
      },
      async (input): Promise<CallToolResult> => {
        const result = await tool.call(context, input);
        return result.ok
          ? {
              content: [{ type: "text", text: JSON.stringify(result.value) }],
              structuredContent: result.value,
            }
          : {
              isError: true,
              content: [{ type: "text", text: result.message }],
            };
      },
    );
  return server;
}
