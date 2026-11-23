import { and, eq, lte, or } from "drizzle-orm";
import type { Database } from "../db";
import { mcpUploadClaims } from "../db/schema";

/**
 * The paths each MCP upload link is writing or has written: a link writes each path once.
 * Rows live in the database, which every server process shares, so two servers running side
 * by side during an update can neither run nor commit one path for one link.
 *
 * An upload reserves its path when it is admitted, while its link is still valid, and keeps
 * the reservation until it ends, however long after the link expires that is: it then either
 * marks it committed or releases it. A committed row is kept while its link could admit
 * another upload; once the link has expired it admits nothing, so the row may go.
 */
export type Reservation =
  | { kind: "reserved" }
  /** Another upload of this path with this link is running. */
  | { kind: "running" }
  /** This link already wrote this path. */
  | { kind: "committed" }
  /** The link has expired, so it admits nothing. */
  | { kind: "expired" };

/** Reservations of uploads that never ended, such as on a server that crashed, last this long. */
const abandonedMs = 24 * 60 * 60 * 1000;

export const UploadClaims = {
  /** Reserve `key` for an upload admitted at `now` with a link that expires at `expiresAt`. */
  reserve(
    db: Database,
    key: string,
    expiresAt: number,
    now: number,
  ): Reservation {
    return db.transaction((tx): Reservation => {
      // In the same transaction as the expiry check: a row goes only once its link admits
      // nothing, so no admission can take a path a pruned row held.
      tx.delete(mcpUploadClaims)
        .where(
          or(
            and(
              eq(mcpUploadClaims.state, "committed"),
              lte(mcpUploadClaims.expiresAt, now),
            ),
            lte(mcpUploadClaims.expiresAt, now - abandonedMs),
          ),
        )
        .run();
      if (expiresAt <= now) return { kind: "expired" };
      const taken = tx
        .insert(mcpUploadClaims)
        .values({ key, expiresAt, state: "reserved" })
        .onConflictDoNothing()
        .returning({ key: mcpUploadClaims.key })
        .all();
      if (taken.length === 1) return { kind: "reserved" };
      const existing = tx
        .select({ state: mcpUploadClaims.state })
        .from(mcpUploadClaims)
        .where(eq(mcpUploadClaims.key, key))
        .get();
      return existing?.state === "committed"
        ? { kind: "committed" }
        : { kind: "running" };
    });
  },

  /** Mark `key`'s reservation committed: its content is in place. */
  commit(db: Database, key: string) {
    db.update(mcpUploadClaims)
      .set({ state: "committed" })
      .where(eq(mcpUploadClaims.key, key))
      .run();
  },

  /** Give back `key`'s reservation for an upload that committed nothing. Never a commit. */
  release(db: Database, key: string) {
    db.delete(mcpUploadClaims)
      .where(
        and(
          eq(mcpUploadClaims.key, key),
          eq(mcpUploadClaims.state, "reserved"),
        ),
      )
      .run();
  },
} as const;
