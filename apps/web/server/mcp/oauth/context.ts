import type { Database } from "../../db";

export type { Database };

/** The signed-in browser user, from the Better Auth session. */
export type BrowserSession = {
  userId: string;
  sessionId: string;
  /** The administrator signed in as this user, or null for the user's own session. */
  impersonatedBy: string | null;
};

/**
 * Dependencies of the OAuth endpoints. Routes build it from the environment
 * (../runtime.ts); tests pass a temporary database, a fixed clock, and a fake session.
 */
export type OAuthContext = {
  db: Database;
  /** Issuer: the public origin without a trailing slash. */
  origin: string;
  /** Signs consent forms. Never logged. */
  secret: string;
  now: () => number;
  getSession: (headers: Headers) => Promise<BrowserSession | null>;
};
