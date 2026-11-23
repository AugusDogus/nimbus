import { GuessBudgets } from "./guess-budgets";
import type { RateLimitDecision, RateLimitRule } from "./rate-limit";

export type CredentialAttempt<T> =
  | { kind: "verified"; value: T }
  | { kind: "rejected" }
  | (Extract<RateLimitDecision, { allowed: false }> & { kind: "throttled" });

/**
 * Limits wrong credentials per client. Each attempt is counted when it begins, so parallel
 * guesses cannot all pass a check that counts failures only afterwards, and given back when
 * the credentials are right, so a client making many correct requests is never slowed.
 * This is the pattern of the link password limiter (`link-password-attempts.ts`).
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
  /** Attempts counted as guess budget `name` (see GuessBudgets), which outlives restarts. */
  create(name: string, rule: RateLimitRule): CredentialAttempts {
    const failures = GuessBudgets.limiter(name, rule);
    return {
      async run<T>(key: string, verify: () => Promise<T | null>) {
        const decision = failures.consume(key);
        if (!decision.allowed)
          return { kind: "throttled", ...decision } as const;
        const value = await verify().catch((error: unknown) => {
          failures.refund(key);
          throw error;
        });
        if (value === null) return { kind: "rejected" } as const;
        failures.refund(key);
        return { kind: "verified", value } as const;
      },
      fail(key) {
        failures.consume(key);
      },
    };
  },
} as const;
