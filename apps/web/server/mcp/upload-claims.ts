import { and, eq, lte } from "drizzle-orm";
import type { Database } from "../db";
import { mcpUploadClaims } from "../db/schema";

/**
 * The paths each MCP upload link is writing or has written: a link writes each path once.
 * Rows live in the database, which every server process shares, so two servers running side
 * by side during an update can neither run nor commit one path for one link.
 *
 * An upload reserves its path when it is admitted, while its link is still valid, and keeps
 * the reservation until it ends, however long after the link expires that is: it then marks it
 * committed, also when it cannot tell whether its content is in place, or releases it when it
 * knows nothing was. A reservation whose server exited counts as committed (`settleOwnedBy`).
 * A committed row is kept while its link could admit another upload; once the link has
 * expired it admits nothing, so the row may go.
 */
export type Reservation =
  | { kind: "reserved" }
  /** Another upload of this path with this link is running. */
  | { kind: "running" }
  /** This link already wrote this path. */
  | { kind: "committed" }
  /** The link has expired, so it admits nothing. */
  | { kind: "expired" };

export const UploadClaims = {
  /**
   * Reserve `key` for an upload server process `owner` admits now, with a link that expires at
   * `expiresAt`. The time is read holding the database's write lock, so no other server
   * commits or prunes between reading it and acting on it.
   */
  reserve(
    db: Database,
    key: string,
    expiresAt: number,
    owner: string,
    clock: () => number,
  ): Reservation {
    return db.transaction(
      (tx): Reservation => {
        const now = clock();
        // In the same transaction as the expiry check: a committed row goes only once its link
        // admits nothing, so no admission can take a path a pruned row held. A reserved row
        // stays however long its upload runs, until it ends or its owner is settled.
        tx.delete(mcpUploadClaims)
          .where(
            and(
              eq(mcpUploadClaims.state, "committed"),
              lte(mcpUploadClaims.expiresAt, now),
            ),
          )
          .run();
        if (expiresAt <= now) return { kind: "expired" };
        const taken = tx
          .insert(mcpUploadClaims)
          .values({ key, expiresAt, state: "reserved", owner })
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
      },
      { behavior: "immediate" },
    );
  },

  /** Mark `key`'s reservation committed: its content is in place, or may be. */
  commit(db: Database, key: string) {
    db.update(mcpUploadClaims)
      .set({ state: "committed", owner: null })
      .where(eq(mcpUploadClaims.key, key))
      .run();
  },

  /** Give back `key`'s reservation for an upload known to have committed nothing. Never a commit. */
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

  /**
   * Settle the reservations of server process `owner`, which has exited: an upload it was
   * running may have put its content in place before it stopped, so each counts as committed
   * and its link cannot write the path again. They go once their links expire.
   */
  settleOwnedBy(db: Database, owner: string) {
    db.update(mcpUploadClaims)
      .set({ state: "committed", owner: null })
      .where(
        and(
          eq(mcpUploadClaims.state, "reserved"),
          eq(mcpUploadClaims.owner, owner),
        ),
      )
      .run();
  },

  /** As `settleOwnedBy` for every reservation: for a server that starts with no other running. */
  settleAll(db: Database) {
    db.update(mcpUploadClaims)
      .set({ state: "committed", owner: null })
      .where(eq(mcpUploadClaims.state, "reserved"))
      .run();
  },
} as const;
