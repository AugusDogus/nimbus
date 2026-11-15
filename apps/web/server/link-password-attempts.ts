import { ClientIp } from "./client-ip";
import { RateLimiter, type RateLimitDecision } from "./rate-limit";

/**
 * Wrong passwords for a public link (a share or a file request), counted per
 * client and per link. Check before verifying the password hash, so throttled
 * guesses cost no hashing, and record a failure after a wrong password.
 */
export type LinkPasswordAttempts = {
  check(linkKey: string, request: Request): RateLimitDecision;
  fail(linkKey: string, request: Request): void;
};

const clientKey = (request: Request) =>
  ClientIp.bucket(ClientIp.fromHeaders(request.headers));

export const LinkPasswordAttempts = {
  /** One pair of limiters per kind of link, shared across bundles in this process. */
  create(kind: string): LinkPasswordAttempts {
    const byClient = RateLimiter.shared(`${kind}-password-client`, {
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
    const byLink = RateLimiter.shared(`${kind}-password-link`, {
      limit: 50,
      windowMs: 60 * 60 * 1000,
    });
    return {
      check(linkKey, request) {
        for (const decision of [
          byClient.check(clientKey(request)),
          byLink.check(linkKey),
        ])
          if (!decision.allowed) return decision;
        return { allowed: true };
      },
      fail(linkKey, request) {
        byClient.consume(clientKey(request));
        byLink.consume(linkKey);
      },
    };
  },
} as const;
