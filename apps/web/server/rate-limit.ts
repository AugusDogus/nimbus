/**
 * In-memory rate limiting for routes outside Better Auth (WebDAV, public link and file request
 * passwords, file request uploads, MCP and its OAuth endpoints).
 * Uses GCRA: one timestamp per key, smooth refill, and bursts up to `limit` per window.
 * State lives in this process and resets on restart, matching Nimbus's one-process model.
 */
export type RateLimitRule = { limit: number; windowMs: number };
export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export type RateLimiter = {
  /** Whether one more event for this key would be allowed, without counting it. */
  check(key: string, now?: number): RateLimitDecision;
  /** Counts one event and returns whether it was allowed. */
  consume(key: string, now?: number): RateLimitDecision;
  /** Forget every key, as a restart would. */
  clear(): void;
  readonly size: number;
};

const decide = (rule: RateLimitRule, tat: number | undefined, now: number) => {
  const interval = rule.windowMs / rule.limit;
  const next = Math.max(tat ?? now, now) + interval;
  return next - now > rule.windowMs
    ? ({ allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((next - now - rule.windowMs) / 1000)) } as const)
    : ({ allowed: true, next } as const);
};

export const RateLimiter = {
  create(rule: RateLimitRule, maxKeys = 50_000): RateLimiter {
    const arrivals = new Map<string, number>();
    const prune = (now: number) => {
      for (const [key, tat] of arrivals) if (tat <= now) arrivals.delete(key);
      // Bound memory under address-spraying: forget the oldest keys first.
      for (const key of arrivals.keys()) {
        if (arrivals.size < maxKeys) break;
        arrivals.delete(key);
      }
    };
    return {
      check(key, now = Date.now()) {
        const decision = decide(rule, arrivals.get(key), now);
        return decision.allowed ? { allowed: true } : decision;
      },
      consume(key, now = Date.now()) {
        const decision = decide(rule, arrivals.get(key), now);
        if (!decision.allowed) return decision;
        if (arrivals.size >= maxKeys && !arrivals.has(key)) prune(now);
        arrivals.delete(key);
        arrivals.set(key, decision.next);
        return { allowed: true };
      },
      clear() {
        arrivals.clear();
      },
      get size() {
        return arrivals.size;
      },
    };
  },
  /** One limiter per name per process, shared by the custom server and Next.js bundles. */
  shared(name: string, rule: RateLimitRule): RateLimiter {
    const registry = ((globalThis as typeof globalThis & { __nimbusRateLimiters?: Map<string, RateLimiter> }).__nimbusRateLimiters ??= new Map());
    const existing = registry.get(name);
    if (existing) return existing;
    const limiter = RateLimiter.create(rule);
    registry.set(name, limiter);
    return limiter;
  },
  /** A wait for messages, such as "1 second" or "30 seconds". */
  seconds(count: number) {
    return `${count} ${count === 1 ? "second" : "seconds"}`;
  },
  /** A 429 response with Retry-After and a message saying when to try again. */
  response(decision: Extract<RateLimitDecision, { allowed: false }>, what: string) {
    const minutes = Math.ceil(decision.retryAfterSeconds / 60);
    return Response.json(
      { error: `Too many ${what}. Wait ${minutes === 1 ? "a minute" : `${minutes} minutes`} and try again.` },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds), "Cache-Control": "no-store" } },
    );
  },
} as const;
