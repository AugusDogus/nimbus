import { preflight } from "@/server/mcp/oauth/http";
import { handleRevoke } from "@/server/mcp/oauth/tokens";
import { withMcp } from "@/server/mcp/runtime";

/** RFC 7009 token revocation. */
export const POST = (request: Request) =>
  withMcp("revoke", (oauth) => handleRevoke(oauth, request));
export const OPTIONS = () => preflight("POST");
