import { GuessBudgets } from "../server/guess-budgets";
import type { RateLimitDecision, RateLimitRule } from "../server/rate-limit";

/**
 * Password sign-in attempts per account, on top of Better Auth's per-address limit, so
 * many addresses cannot guess one account's password at full speed. Attempts are counted
 * when they start (parallel guesses cannot all pass a check first) and refill smoothly, so
 * guessing slows to a trickle instead of locking the account. Addresses the account signed
 * in from with its password are exempt, so an attacker keeping the limit busy does not
 * lock its owner out of a known device; passkeys and single sign-on are never limited here.
 * The budget is kept with the other guess budgets (GuessBudgets), in the database once the
 * server starts, so a restart or an update never resets it. Known addresses stay in this
 * process's memory: forgetting them only limits their owner as any other address.
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
    maxAccounts = 50_000,
  }: {
    rule?: RateLimitRule;
    addressesPerAccount?: number;
    maxAccounts?: number;
  } = {}): PasswordAttempts {
    const attempts = GuessBudgets.limiter("password-account", rule);
    /** Per account, its known addresses in least recently used order. */
    const known = new Map<string, Set<string>>();
    return {
      admit(email, address, now = Date.now()) {
        const key = accountKey(email);
        if (known.get(key)?.has(address)) return { allowed: true };
        return attempts.consume(key, now);
      },
      succeeded(email, address) {
        const key = accountKey(email);
        const addresses = known.get(key) ?? new Set<string>();
        addresses.delete(address);
        addresses.add(address);
        for (const oldest of addresses) {
          if (addresses.size <= addressesPerAccount) break;
          addresses.delete(oldest);
        }
        known.delete(key);
        known.set(key, addresses);
        for (const oldest of known.keys()) {
          if (known.size <= maxAccounts) break;
          known.delete(oldest);
        }
      },
    };
  },
} as const;
