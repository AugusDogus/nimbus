import {
  RateLimiter,
  type RateLimitDecision,
  type RateLimitRule,
} from "./rate-limit";

export type CredentialAttempt<T> =
  | { kind: "verified"; value: T }
  | { kind: "rejected" }
  | (Extract<RateLimitDecision, { allowed: false }> & { kind: "throttled" });

/**
 * Limits wrong credentials per client. Only failures count, so a client making many
 * correct requests is never slowed. Each client's checks run one at a time, so parallel
 * guesses cannot all pass the limit before the first failure is counted.
 */
export type CredentialAttempts = {
  /** Verifies with `verify` (null means wrong credentials) unless `key` is over the limit. */
  run<T>(
    key: string,
    verify: () => Promise<T | null>,
  ): Promise<CredentialAttempt<T>>;
  /** Counts a failure found outside `run`. */
  fail(key: string): void;
};

export const CredentialAttempts = {
  create(rule: RateLimitRule): CredentialAttempts {
    const failures = RateLimiter.create(rule);
    /** The tail of each client's queue of checks. */
    const queues = new Map<string, Promise<unknown>>();
    return {
      async run<T>(key: string, verify: () => Promise<T | null>) {
        const previous = queues.get(key) ?? Promise.resolve();
        const attempt = previous.then(
          async (): Promise<CredentialAttempt<T>> => {
            const decision = failures.check(key);
            if (!decision.allowed) return { kind: "throttled", ...decision };
            const value = await verify();
            if (value !== null) return { kind: "verified", value };
            failures.consume(key);
            return { kind: "rejected" };
          },
        );
        const tail = attempt.catch(() => undefined);
        queues.set(key, tail);
        void tail.then(() => {
          if (queues.get(key) === tail) queues.delete(key);
        });
        return attempt;
      },
      fail(key) {
        failures.consume(key);
      },
    };
  },
} as const;
