import { and, eq, lte } from "drizzle-orm";
import type { Database } from "./db/connection";
import { authRateLimits, guessBudgets, spentCodes } from "./db/schema";
import {
  RateLimiter,
  type RateLimitDecision,
  type RateLimitRule,
} from "./rate-limit";

/**
 * Budgets for guessing secrets: link passwords, WebDAV credentials, and Better Auth's limits on
 * sign-in and its other endpoints. Ordinary request rate limits stay in each process
 * (RateLimiter); these must not, or every restart, and every update the supervisor makes
 * without stopping, would hand a guesser a fresh budget, and two servers running side by side
 * would each grant one. The server keeps them in its database (`use`); without one, as in
 * tests, they stay in this process's memory.
 */
export type AuthRateLimitStorage = {
  consume(
    key: string,
    rule: { window: number; max: number },
  ): Promise<{ allowed: boolean; retryAfter: number | null }>;
};

/** One-time codes, such as authenticator codes, that may be accepted once each. */
export type SpentCodes = {
  /** Spend `key` until `expiresAt`: false when it was spent already and is still valid. */
  spend(key: string, expiresAt: number, now: number): boolean;
  /** Give back a code whose verification failed. */
  unspend(key: string): void;
};

type Backend = {
  limiter(name: string, rule: RateLimitRule): RateLimiter;
  auth: AuthRateLimitStorage;
  codes: SpentCodes;
};

/** One GCRA step, as RateLimiter decides it: the next arrival time, and whether it fits. */
function decide(rule: RateLimitRule, tat: number | undefined, now: number) {
  const interval = rule.windowMs / rule.limit;
  const next = Math.max(tat ?? now, now) + interval;
  const decision: RateLimitDecision =
    next - now > rule.windowMs
      ? {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((next - now - rule.windowMs) / 1000),
          ),
        }
      : { allowed: true };
  return { decision, next, interval };
}

/** Budgets in the database, each change in one transaction, so concurrent guesses all count. */
function durable(db: Database): Backend {
  const tatOf = (
    tx: Pick<Database, "select">,
    name: string,
    key: string,
  ): number | undefined =>
    tx
      .select({ tat: guessBudgets.tat })
      .from(guessBudgets)
      .where(and(eq(guessBudgets.name, name), eq(guessBudgets.key, key)))
      .get()?.tat;
  return {
    limiter(name, rule) {
      const where = (key: string) =>
        and(eq(guessBudgets.name, name), eq(guessBudgets.key, key));
      return {
        check(key, now = Date.now()) {
          return decide(rule, tatOf(db, name, key), now).decision;
        },
        consume(key, now = Date.now()) {
          return db.transaction((tx) => {
            // A key whose budget is whole again holds no state.
            tx.delete(guessBudgets)
              .where(
                and(eq(guessBudgets.name, name), lte(guessBudgets.tat, now)),
              )
              .run();
            const { decision, next } = decide(rule, tatOf(tx, name, key), now);
            if (decision.allowed)
              tx.insert(guessBudgets)
                .values({ name, key, tat: next })
                .onConflictDoUpdate({
                  target: [guessBudgets.name, guessBudgets.key],
                  set: { tat: next },
                })
                .run();
            return decision;
          });
        },
        refund(key, now = Date.now()) {
          db.transaction((tx) => {
            const tat = tatOf(tx, name, key);
            if (tat === undefined) return;
            const earlier = tat - rule.windowMs / rule.limit;
            if (earlier <= now) tx.delete(guessBudgets).where(where(key)).run();
            else
              tx.update(guessBudgets)
                .set({ tat: earlier })
                .where(where(key))
                .run();
          });
        },
        clear() {
          db.delete(guessBudgets).where(eq(guessBudgets.name, name)).run();
        },
        get size() {
          return db
            .select({ key: guessBudgets.key })
            .from(guessBudgets)
            .where(eq(guessBudgets.name, name))
            .all().length;
        },
      };
    },
    auth: {
      async consume(key, rule) {
        const now = Date.now();
        return db.transaction((tx) => {
          tx.delete(authRateLimits)
            .where(lte(authRateLimits.windowEnd, now))
            .run();
          const row = tx
            .select()
            .from(authRateLimits)
            .where(eq(authRateLimits.key, key))
            .get();
          if (!row) {
            tx.insert(authRateLimits)
              .values({
                key,
                count: 1,
                windowStart: now,
                windowEnd: now + rule.window * 1000,
              })
              .run();
            return { allowed: true, retryAfter: null };
          }
          if (row.count >= rule.max)
            return {
              allowed: false,
              retryAfter: Math.max(1, Math.ceil((row.windowEnd - now) / 1000)),
            };
          tx.update(authRateLimits)
            .set({ count: row.count + 1 })
            .where(eq(authRateLimits.key, key))
            .run();
          return { allowed: true, retryAfter: null };
        });
      },
    },
    codes: {
      spend(key, expiresAt, now) {
        return db.transaction((tx) => {
          tx.delete(spentCodes).where(lte(spentCodes.expiresAt, now)).run();
          return (
            tx
              .insert(spentCodes)
              .values({ key, expiresAt })
              .onConflictDoNothing()
              .returning({ key: spentCodes.key })
              .all().length === 1
          );
        });
      },
      unspend(key) {
        db.delete(spentCodes).where(eq(spentCodes.key, key)).run();
      },
    },
  };
}

/** Better Auth's limits in this process's memory, until the server installs its database. */
function memoryAuth(): AuthRateLimitStorage {
  const windows = new Map<string, { count: number; end: number }>();
  return {
    async consume(key, rule) {
      const now = Date.now();
      const current = windows.get(key);
      if (!current || current.end <= now) {
        windows.set(key, { count: 1, end: now + rule.window * 1000 });
        return { allowed: true, retryAfter: null };
      }
      if (current.count >= rule.max)
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil((current.end - now) / 1000)),
        };
      current.count++;
      return { allowed: true, retryAfter: null };
    },
  };
}

/** Spent codes in this process's memory, until the server installs its database. */
function memoryCodes(): SpentCodes {
  const spent = new Map<string, number>();
  return {
    spend(key, expiresAt, now) {
      for (const [code, until] of spent) if (until <= now) spent.delete(code);
      if (spent.has(key)) return false;
      spent.set(key, expiresAt);
      return true;
    },
    unspend(key) {
      spent.delete(key);
    },
  };
}

/** The database's budgets once the server installed it; until then each user keeps its own. */
let installed: Backend | null = null;

export const GuessBudgets = {
  durable,
  /** Keep budgets in `db` from now on, or in memory again with null. Called once at startup. */
  keepIn(db: Database | null) {
    installed = db ? durable(db) : null;
  },
  /**
   * The limiter `name`: in the database every server process shares once the server installed
   * it, otherwise in this limiter's own memory.
   */
  limiter(name: string, rule: RateLimitRule): RateLimiter {
    const local = RateLimiter.create(rule);
    const current = () => installed?.limiter(name, rule) ?? local;
    return {
      check: (key, now) => current().check(key, now),
      consume: (key, now) => current().consume(key, now),
      refund: (key, now) => current().refund(key, now),
      clear: () => current().clear(),
      get size() {
        return current().size;
      },
    };
  },
  /** Better Auth's request limits, kept as `limiter` keeps its budgets. */
  authStorage(): AuthRateLimitStorage {
    const local = memoryAuth();
    return {
      consume: (key, rule) => (installed?.auth ?? local).consume(key, rule),
    };
  },
  /** One-time codes, kept as `limiter` keeps its budgets. */
  spentCodes(): SpentCodes {
    const local = memoryCodes();
    return {
      spend: (key, expiresAt, now) =>
        (installed?.codes ?? local).spend(key, expiresAt, now),
      unspend: (key) => (installed?.codes ?? local).unspend(key),
    };
  },
} as const;
