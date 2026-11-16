import { preflight } from "@/server/mcp/oauth/http";
import { handleToken } from "@/server/mcp/oauth/tokens";
import { withMcp } from "@/server/mcp/runtime";

/** authorization_code (PKCE) and refresh_token (rotation) grants. */
export const POST = (request: Request) =>
  withMcp("token", (oauth) => handleToken(oauth, request));
export const OPTIONS = () => preflight("POST");
