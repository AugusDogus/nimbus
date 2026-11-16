import { decideConsent } from "@/server/mcp/oauth/authorization";
import { withMcp } from "@/server/mcp/runtime";

/** The consent form's Approve or Deny. */
export const POST = (request: Request) =>
  withMcp("consent decision", (oauth) => decideConsent(oauth, request), "html");
