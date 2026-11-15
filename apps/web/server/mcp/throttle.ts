export type ThrottleRule = { limit: number; windowMs: number };
export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

type Window = { start: number; count: number };

// One Nimbus process serves a data root (see README), so counters live in memory.
// Next bundles route handlers separately; share one map per process.
declare global {
  var nimbusMcpThrottle: Map<string, Window> | undefined;
}
const windows = () => (globalThis.nimbusMcpThrottle ??= new Map());

/** Bounds the map: drop windows that ended, at most once per minute. */
let lastPrune = 0;
function prune(now: number) {
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  for (const [key, window] of windows()) if (now - window.start > 60 * 60 * 1000) windows().delete(key);
}

/** Fixed-window counter. Every rule must allow; the longest wait wins. */
export function hit(checks: readonly { key: string; rule: ThrottleRule }[], now = Date.now()): ThrottleDecision {
  prune(now);
  let decision: ThrottleDecision = { allowed: true };
  for (const { key, rule } of checks) {
    const current = windows().get(key);
    const window = current && now - current.start < rule.windowMs ? current : { start: now, count: 0 };
    window.count++;
    windows().set(key, window);
    if (window.count > rule.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((window.start + rule.windowMs - now) / 1000));
      if (decision.allowed || retryAfterSeconds > decision.retryAfterSeconds)
        decision = { allowed: false, retryAfterSeconds };
    }
  }
  return decision;
}

export const throttleRules = {
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
} as const satisfies Record<string, ThrottleRule>;

export function resetThrottleForTest() {
  windows().clear();
  lastPrune = 0;
}
