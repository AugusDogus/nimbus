import { ClientIp } from "./client-ip";
import { RateLimiter, type RateLimitDecision } from "./rate-limit";

/** An attempt to unlock a public link with a password. */
export type LinkPasswordAttempt =
  /** Verify the password now; call `succeeded` if it was right, which gives the attempt back. */
  | { kind: "admitted"; succeeded(): void }
  | {
      kind: "refused";
      decision: Extract<RateLimitDecision, { allowed: false }>;
    };

/**
 * Password attempts for a public link (a share or a file request), counted per client and per
 * link. An attempt is counted when it begins, before the password hash is checked, so guesses
 * sent in parallel cannot all pass a check that only counts failures afterwards.
 *
 * The per-client limit refuses. The per-link limit only throttles: a link that has used its
 * budget of guesses (from many addresses) admits one attempt at a time, spaced out, and makes
 * each wait for its turn. The owner's correct password is then still checked after a short
 * wait instead of being refused, while guesses on that link stay bounded by the spacing.
 */
export type LinkPasswordAttempts = {
  begin(linkKey: string, request: Request): Promise<LinkPasswordAttempt>;
};

type Options = {
  /** Spacing between attempts on a link that is over its budget. */
  throttledIntervalMs?: number;
  /** Longest an attempt waits for its turn; longer waits are refused. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const clientKey = (request: Request) =>
  ClientIp.bucket(ClientIp.fromHeaders(request.headers));

export const LinkPasswordAttempts = {
  /** One pair of limiters per kind of link, shared across bundles in this process. */
  create(
    kind: string,
    {
      throttledIntervalMs = 10_000,
      maxWaitMs = 30_000,
      sleep = (ms) => Bun.sleep(ms),
    }: Options = {},
  ): LinkPasswordAttempts {
    const byClient = RateLimiter.shared(`${kind}-password-client`, {
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
    const byLink = RateLimiter.shared(`${kind}-password-link`, {
      limit: 50,
      windowMs: 60 * 60 * 1000,
    });
    // The next free turn per throttled link. Turns are reserved synchronously, in arrival order.
    const turns = new Map<string, number>();
    return {
      async begin(linkKey, request) {
        const client = clientKey(request);
        const decision = byClient.consume(client);
        if (!decision.allowed) return { kind: "refused", decision };
        const countedOnLink = byLink.consume(linkKey).allowed;
        if (!countedOnLink) {
          const now = Date.now();
          for (const [key, turn] of turns) if (turn <= now) turns.delete(key);
          const turn = Math.max(now, turns.get(linkKey) ?? now);
          if (turn - now > maxWaitMs) {
            byClient.refund(client);
            return {
              kind: "refused",
              decision: {
                allowed: false,
                retryAfterSeconds: Math.ceil((turn - now) / 1000),
              },
            };
          }
          turns.set(linkKey, turn + throttledIntervalMs);
          await sleep(Math.max(1, turn - now));
        }
        return {
          kind: "admitted",
          succeeded() {
            byClient.refund(client);
            if (countedOnLink) byLink.refund(linkKey);
          },
        };
      },
    };
  },
} as const;
