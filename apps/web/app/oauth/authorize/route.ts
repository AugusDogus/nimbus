import { handleAuthorize } from "@/server/mcp/oauth/authorization";
import { withMcp } from "@/server/mcp/runtime";

/** OAuth 2.1 authorization endpoint for MCP clients. */
export const GET = (request: Request) => withMcp("authorize", (oauth) => handleAuthorize(oauth, request), "html");
