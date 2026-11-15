/**
 * Deployment settings for the MCP server. `NIMBUS_MCP_ENABLED=false` removes
 * the MCP endpoint, its OAuth endpoints and discovery documents; existing
 * client approvals stay stored and work again when it is re-enabled.
 */
export type McpConfig =
  | { kind: "enabled"; origin: string; secret: string }
  | { kind: "disabled" }
  | { kind: "misconfigured"; message: string };

export function readMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const enabled = env.NIMBUS_MCP_ENABLED;
  if (enabled === "false") return { kind: "disabled" };
  if (enabled !== undefined && enabled !== "true")
    return {
      kind: "misconfigured",
      message: `NIMBUS_MCP_ENABLED is "${enabled.slice(0, 20)}". Set it to true or false and restart Nimbus. MCP requests are refused until then.`,
    };
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    return { kind: "misconfigured", message: "BETTER_AUTH_SECRET must be set to at least 32 characters for MCP authorization." };
  const origin = new URL(env.BETTER_AUTH_URL ?? `http://localhost:${env.PORT ?? "3000"}`).origin;
  return { kind: "enabled", origin, secret };
}

/** RFC 8707 resource identifier and endpoint of the MCP server. */
export const mcpResource = (origin: string) => `${origin}/api/mcp`;
export const protectedResourceMetadataUrl = (origin: string) =>
  `${origin}/.well-known/oauth-protected-resource/api/mcp`;
