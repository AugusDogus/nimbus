import { createMcpHandler } from "@modelcontextprotocol/server";
import { McpScope } from "@nimbus/api/mcp-scope";
import { z } from "zod";
import { driveStore } from "@/server/services";
import { preferencesStore } from "@/server/preferences";
import {
  mcpResource,
  protectedResourceMetadataUrl,
  readMcpConfig,
} from "@/server/mcp/config";
import { signDownloadLink } from "@/server/mcp/download-link";
import { json } from "@/server/mcp/oauth/http";
import { authenticateBearer } from "@/server/mcp/oauth/tokens";
import {
  allowedOrigins,
  guardTransport,
  throttleAnonymous,
  throttleConnection,
  type GuardDecision,
} from "@/server/mcp/request-guard";
import { withMcp } from "@/server/mcp/runtime";
import { createNimbusMcpServer } from "@/server/mcp/server";

/** The verified connection, carried from authentication to the per-request server factory. */
const connectionSchema = z.object({
  userId: z.string().min(1),
  grantId: z.string().min(1),
});

const handler = createMcpHandler(
  ({ authInfo }) => {
    const connection = connectionSchema.parse(authInfo?.extra);
    const config = readMcpConfig();
    if (config.kind !== "enabled")
      throw new Error("MCP configuration changed while serving a request.");
    return createNimbusMcpServer({
      userId: connection.userId,
      scopes: (authInfo?.scopes ?? []).filter(McpScope.isScope),
      drive: driveStore,
      preferences: preferencesStore,
      origin: config.origin,
      downloadLink: async (path) => {
        const link = signDownloadLink(
          config.secret,
          connection.grantId,
          path,
          Date.now(),
        );
        return {
          url: `${config.origin}/api/mcp/download?token=${link.token}`,
          expiresAt: link.expiresAt,
        };
      },
    });
  },
  {
    // write_text accepts 4 MiB of text; JSON escaping can grow it.
    maxRequestBodySize: 12 * 1024 * 1024,
    // Names only: SDK errors can echo request content such as file text.
    onerror: (error) => console.error(`[mcp] request failed: ${error.name}`),
  },
);

const quote = (value: string) => `"${value.replace(/["\\\r\n]/g, "")}"`;

const refuse = (decision: Extract<GuardDecision, { allowed: false }>) =>
  json(
    {
      error: decision.status === 429 ? "rate_limited" : "forbidden",
      error_description: decision.message,
    },
    {
      status: decision.status,
      headers: decision.retryAfterSeconds
        ? { "Retry-After": String(decision.retryAfterSeconds) }
        : {},
    },
  );

/** Streamable HTTP MCP endpoint. Each request carries an access token from Nimbus's OAuth server. */
const handle = (request: Request) =>
  withMcp("request", async (oauth) => {
    const transport = guardTransport(
      request,
      allowedOrigins(oauth.origin, process.env.BETTER_AUTH_TRUSTED_ORIGINS),
    );
    if (!transport.allowed) return refuse(transport);
    const auth = await authenticateBearer(oauth, request);
    if (auth.kind !== "authenticated") {
      const limited = throttleAnonymous(request);
      if (!limited.allowed) return refuse(limited);
      const challenge = [
        ...(auth.kind === "rejected"
          ? [
              `error="invalid_token"`,
              `error_description=${quote(auth.message)}`,
            ]
          : []),
        `resource_metadata=${quote(protectedResourceMetadataUrl(oauth.origin))}`,
      ];
      return json(
        auth.kind === "rejected"
          ? { error: "invalid_token", error_description: auth.message }
          : {
              error: "unauthorized",
              error_description:
                "Connect this client to Nimbus: it will open Nimbus in your browser to approve access.",
            },
        {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer ${challenge.join(", ")}` },
        },
      );
    }
    const limited = throttleConnection(auth.grantId);
    if (!limited.allowed) return refuse(limited);
    const token =
      /^Bearer +(\S+)/i.exec(request.headers.get("authorization") ?? "")?.[1] ??
      "";
    return handler.fetch(request, {
      authInfo: {
        token,
        clientId: auth.clientId,
        scopes: auth.scopes,
        resource: new URL(mcpResource(oauth.origin)),
        resourceMetadataUrl: protectedResourceMetadataUrl(oauth.origin),
        extra: { userId: auth.userId, grantId: auth.grantId },
      },
    });
  });

export { handle as DELETE, handle as GET, handle as POST };
