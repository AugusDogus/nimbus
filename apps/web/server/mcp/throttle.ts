import { ClientIp } from "../client-ip";
import { RateLimiter, type RateLimitDecision } from "../rate-limit";

/** MCP and its OAuth endpoints, limited with Nimbus's shared in-memory limiter. */
const rules = {
  registerPerAddress: { limit: 30, windowMs: 10 * 60 * 1000 },
  /** Bounds what open registration can store per hour, however many addresses a caller has. */
  registerGlobal: { limit: 300, windowMs: 60 * 60 * 1000 },
  tokenPerAddress: { limit: 120, windowMs: 60 * 1000 },
  /** Per client and address: client ids are public, so a per-client bucket alone would let anyone block a client. */
  tokenPerClient: { limit: 60, windowMs: 60 * 1000 },
  /** Unauthenticated MCP requests (discovery probes, bad tokens). */
  mcpPerAddress: { limit: 300, windowMs: 60 * 1000 },
  /** Authenticated MCP requests per approved connection. */
  mcpPerGrant: { limit: 600, windowMs: 60 * 1000 },
} as const;

export type ThrottleRule = keyof typeof rules;

const limiters = new Map(
  Object.entries(rules).map(([name, rule]) => [name, RateLimiter.shared(`mcp-${name}`, rule)]),
);

/** Count one request against every check. Every check must allow; the longest wait wins. */
export function hit(
  checks: readonly { key: string; rule: ThrottleRule }[],
  now = Date.now(),
): RateLimitDecision {
  let decision: RateLimitDecision = { allowed: true };
  for (const { key, rule } of checks) {
    const limiter = limiters.get(rule);
    if (!limiter) throw new Error(`Nimbus has no MCP rate limit named ${rule}.`);
    const result = limiter.consume(key, now);
    if (!result.allowed && (decision.allowed || result.retryAfterSeconds > decision.retryAfterSeconds))
      decision = result;
  }
  return decision;
}

/**
 * The caller's rate-limit bucket: the client address the server derived from the
 * socket and trusted proxies, with IPv6 counted per /64.
 */
export const clientAddress = (request: Request) =>
  ClientIp.bucket(ClientIp.fromHeaders(request.headers));

export function resetThrottleForTest() {
  for (const limiter of limiters.values()) limiter.clear();
}
