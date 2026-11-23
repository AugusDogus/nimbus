import type { DriveStore } from "@nimbus/api/drive-store";
import type { Database } from "../db/connection";
import type { BrowserSession } from "../mcp/oauth/context";

export type { BrowserSession };

/**
 * Where pairing sends the owner's phone or browser. Only the configured public address is
 * used, never the request's Host header, which anyone can set; without one, pairing is
 * unavailable.
 */
export type PairingOrigin =
  | { kind: "configured"; origin: string }
  | { kind: "unavailable"; reason: string };

/**
 * What the library API depends on. `library-runtime.ts` builds it from the environment; tests
 * pass a migrated temporary database, a fixed clock and a fake session.
 */
export type LibraryContext = {
  db: Database;
  drive: DriveStore;
  origin: PairingOrigin;
  /** Signs the pairing page's review tickets. Never logged. */
  secret: string;
  now: () => number;
  getSession: (headers: Headers) => Promise<BrowserSession | null>;
};

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const PairingOrigin = {
  /** From BETTER_AUTH_URL: HTTPS, or plain HTTP on this machine for development and tests. */
  read(env: Record<string, string | undefined> = process.env): PairingOrigin {
    const configured = env.BETTER_AUTH_URL;
    if (!configured)
      return {
        kind: "unavailable",
        reason:
          "Device pairing needs the server's public address. Ask the administrator to set BETTER_AUTH_URL to this server's HTTPS address and restart Nimbus.",
      };
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      return {
        kind: "unavailable",
        reason:
          "This server's public address (BETTER_AUTH_URL) is not a valid URL, so device pairing is unavailable. Ask the administrator to correct it and restart Nimbus.",
      };
    }
    if (url.protocol !== "https:" && !loopback.has(url.hostname))
      return {
        kind: "unavailable",
        reason:
          "Device pairing needs HTTPS. Ask the administrator to serve Nimbus over HTTPS and set BETTER_AUTH_URL to that address.",
      };
    return { kind: "configured", origin: url.origin };
  },
} as const;
