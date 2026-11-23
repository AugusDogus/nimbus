import { GuessBudgets } from "../server/guess-budgets";
import type { RateLimitDecision, RateLimitRule } from "../server/rate-limit";

/**
 * Password sign-in attempts per account, on top of Better Auth's per-address limit, so
 * many addresses cannot guess one account's password at full speed. Attempts are counted
 * when they start (parallel guesses cannot all pass a check first) and refill smoothly, so
 * guessing slows to a trickle instead of locking the account. Addresses the account signed
 * in from with its password are exempt, so an attacker keeping the limit busy does not
 * lock its owner out of a known device; passkeys and single sign-on are never limited here.
 * The budget and each account's latest known addresses are kept with the other guess budgets
 * (GuessBudgets), in the database once the server starts, so a restart or an update neither
 * resets the budget nor makes its owner's known devices wait behind a guesser.
 */
export type PasswordAttempts = {
  /** Counts one attempt at `email` from `address` and decides whether it may proceed. */
  admit(email: string, address: string, now?: number): RateLimitDecision;
  /** Remembers that `address` knew the password of `email`. */
  succeeded(email: string, address: string): void;
};

const accountKey = (email: string) => email.trim().toLowerCase();

export const PasswordAttempts = {
  create({
    rule = { limit: 10, windowMs: 15 * 60 * 1000 },
    addressesPerAccount = 20,
  }: {
    rule?: RateLimitRule;
    addressesPerAccount?: number;
  } = {}): PasswordAttempts {
    const attempts = GuessBudgets.limiter("password-account", rule);
    const known = GuessBudgets.knownAddresses();
    return {
      admit(email, address, now = Date.now()) {
        const key = accountKey(email);
        if (known.has(key, address)) return { allowed: true };
        return attempts.consume(key, now);
      },
      succeeded(email, address) {
        known.remember(accountKey(email), address, addressesPerAccount);
      },
    };
  },
} as const;
