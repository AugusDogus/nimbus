import { fileTools } from "./mcp-file-tools";
import { sharingTools } from "./mcp-sharing-tools";

/** Every tool the Nimbus MCP server offers, in the order clients list them. */
export const mcpTools = [...fileTools, ...sharingTools];
