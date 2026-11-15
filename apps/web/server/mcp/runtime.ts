import "server-only";
import { auth } from "@/lib/auth";
import { db } from "../db";
import { readMcpConfig } from "./config";
import type { OAuthContext } from "./oauth/context";
import { htmlError, json } from "./oauth/http";

export type McpRuntime = { kind: "ready"; oauth: OAuthContext } | { kind: "unavailable"; response: () => Response };

/**
 * The MCP endpoints' dependencies from the environment, or the response that
 * explains why MCP is unavailable. Disabled MCP answers 404 so clients and
 * scanners cannot tell it apart from a server without MCP.
 */
export function mcpRuntime(format: "json" | "html" = "json"): McpRuntime {
  const config = readMcpConfig();
  if (config.kind === "disabled")
    return {
      kind: "unavailable",
      response: () =>
        format === "html"
          ? htmlError(404, "MCP is turned off", "The administrator of this Nimbus server has turned off connections for AI clients.")
          : json({ error: "not_found", error_description: "MCP is turned off on this Nimbus server." }, { status: 404 }),
    };
  if (config.kind === "misconfigured") {
    console.error(`[mcp] ${config.message}`);
    return {
      kind: "unavailable",
      response: () =>
        format === "html"
          ? htmlError(503, "MCP is unavailable", "This Nimbus server's MCP settings are invalid. Ask its administrator to check the server logs.")
          : json({ error: "temporarily_unavailable", error_description: "MCP is misconfigured on this Nimbus server. Ask its administrator to check the server logs." }, { status: 503 }),
    };
  }
  return {
    kind: "ready",
    oauth: {
      db,
      origin: config.origin,
      secret: config.secret,
      now: Date.now,
      getSession: async (headers) => {
        const session = await auth.api.getSession({ headers });
        return session ? { userId: session.user.id, sessionId: session.session.id } : null;
      },
    },
  };
}

/** Run `handler` when MCP is available, converting unexpected failures into a safe 500. */
export async function withMcp(
  operation: string,
  handler: (oauth: OAuthContext) => Promise<Response>,
  format: "json" | "html" = "json",
) {
  const runtime = mcpRuntime(format);
  if (runtime.kind === "unavailable") return runtime.response();
  try {
    return await handler(runtime.oauth);
  } catch (error) {
    // Names only: database errors can include token hashes in their parameters.
    console.error(`[mcp] ${operation} failed: ${error instanceof Error ? error.name : typeof error}`);
    return format === "html"
      ? htmlError(500, "Something went wrong", "Nimbus could not complete this request. Nothing was shared. Try again in a moment.")
      : json({ error: "server_error", error_description: "Nimbus could not complete this request. Nothing was registered, issued, or revoked. Retry shortly." }, { status: 500 });
  }
}
