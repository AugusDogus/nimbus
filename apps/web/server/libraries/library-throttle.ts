import { RateLimiter, type RateLimitDecision } from "../rate-limit";

/**
 * The library API's abuse limits (docs/library-api/README.md, "Limits"), counted in the shared
 * in-process limiter. Poll intervals and the pending-pairing cap live in SQLite instead,
 * so a restart does not reset them.
 */
const rules = {
  startPerAddress: { limit: 5, windowMs: 10 * 60_000 },
  startGlobal: { limit: 100, windowMs: 10 * 60_000 },
  pollPerAddress: { limit: 30, windowMs: 60_000 },
  /** Pairing page lookups and decisions, per account, per address and for everyone. */
  reviewPerAccount: { limit: 5, windowMs: 10 * 60_000 },
  reviewPerAddress: { limit: 5, windowMs: 10 * 60_000 },
  reviewGlobal: { limit: 100, windowMs: 60_000 },
  decidePerAccount: { limit: 5, windowMs: 10 * 60_000 },
  decidePerAddress: { limit: 5, windowMs: 10 * 60_000 },
  decideGlobal: { limit: 100, windowMs: 60_000 },
  /** Authenticated requests per paired device. */
  perDevice: { limit: 120, windowMs: 60_000 },
  /** Media addresses minted per paired device. */
  mintPerDevice: { limit: 10, windowMs: 60_000 },
  /** File and media byte requests (each range one) per paired device. */
  mediaPerDevice: { limit: 300, windowMs: 60_000 },
  /** Poster requests per paired device. */
  posterPerDevice: { limit: 300, windowMs: 60_000 },
} as const;

export type LibraryThrottleRule = keyof typeof rules;

const limiters = new Map(
  Object.entries(rules).map(([name, rule]) => [
    name,
    RateLimiter.shared(`library-${name}`, rule),
  ]),
);

export const LibraryThrottle = {
  /**
   * Count one request against each check in order, narrowest first. The first refusal stops it
   * and gives back what the earlier checks counted, so a request refused for one address never
   * uses up an allowance shared with everyone.
   */
  hit(
    checks: readonly { key: string; rule: LibraryThrottleRule }[],
    now: number,
  ): RateLimitDecision {
    const counted: { key: string; limiter: RateLimiter }[] = [];
    for (const { key, rule } of checks) {
      const limiter = limiters.get(rule);
      if (!limiter)
        throw new Error(`Nimbus has no library API rate limit named ${rule}.`);
      const decision = limiter.consume(key, now);
      if (!decision.allowed) {
        for (const earlier of counted) earlier.limiter.refund(earlier.key, now);
        return decision;
      }
      counted.push({ key, limiter });
    }
    return { allowed: true };
  },
  resetForTest() {
    for (const limiter of limiters.values()) limiter.clear();
  },
} as const;
