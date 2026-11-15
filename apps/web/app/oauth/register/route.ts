import { registerClient } from "@/server/mcp/oauth/clients";
import { preflight } from "@/server/mcp/oauth/http";
import { withMcp } from "@/server/mcp/runtime";

/** RFC 7591 dynamic client registration. */
export const POST = (request: Request) => withMcp("register", (oauth) => registerClient(oauth, request));
export const OPTIONS = () => preflight("POST");
