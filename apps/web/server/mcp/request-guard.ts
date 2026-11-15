import { clientAddress } from "./oauth/http";
import { hit, throttleRules } from "./throttle";

export type GuardDecision =
  | { allowed: true }
  | { allowed: false; status: 403 | 421 | 429; message: string; retryAfterSeconds?: number };

/** Origins and hosts the MCP endpoint answers for: the public origin plus BETTER_AUTH_TRUSTED_ORIGINS. */
export function allowedOrigins(origin: string, trusted: string | undefined) {
  const origins = new Set([origin]);
  for (const entry of (trusted ?? "").split(",")) {
    const value = entry.trim();
    if (value && URL.canParse(value)) origins.add(new URL(value).origin);
  }
  return origins;
}

/**
 * Transport checks before authentication (MCP Streamable HTTP security
 * guidance): a browser Origin must be Nimbus's own, which blocks DNS
 * rebinding and cross-site calls, and the Host must be one Nimbus serves.
 * Non-browser clients send no Origin and are authenticated by their token.
 */
export function guardTransport(request: Request, origins: ReadonlySet<string>): GuardDecision {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== null && !origins.has(requestOrigin))
    return {
      allowed: false,
      status: 403,
      message: "Requests from web pages on other sites cannot use the Nimbus MCP server. Connect from an MCP client instead.",
    };
  const host = request.headers.get("host");
  if (host !== null && ![...origins].some((origin) => new URL(origin).host === host.toLowerCase()))
    return {
      allowed: false,
      status: 421,
      message: "This Nimbus server does not answer for that host name. Use the server address shown in Nimbus under Settings → MCP.",
    };
  return { allowed: true };
}

const limited = (retryAfterSeconds: number): GuardDecision => ({
  allowed: false,
  status: 429,
  retryAfterSeconds,
  message: `Too many MCP requests. Nothing was done; retry after ${retryAfterSeconds} seconds.`,
});

export function throttleAnonymous(request: Request, now = Date.now()): GuardDecision {
  const decision = hit([{ key: `mcp:${clientAddress(request)}`, rule: throttleRules.mcpPerAddress }], now);
  return decision.allowed ? decision : limited(decision.retryAfterSeconds);
}

export function throttleConnection(grantId: string, now = Date.now()): GuardDecision {
  const decision = hit([{ key: `mcp:grant:${grantId}`, rule: throttleRules.mcpPerGrant }], now);
  return decision.allowed ? decision : limited(decision.retryAfterSeconds);
}
