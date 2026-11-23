import { and, eq, gt, lte } from "drizzle-orm";
import type { Database } from "../db";
import { mcpUploadClaims } from "../db/schema";

/**
 * The paths each MCP upload link has written: a link writes each path once. Claims live in
 * the database, which every server process shares, so two servers running side by side during
 * an update cannot both commit one path for one link. A claim lasts until its link expires.
 */
export const UploadClaims = {
  /** Whether `key` was claimed and its link has not expired at `now`. */
  claimed(db: Database, key: string, now: number) {
    return (
      db
        .select({ key: mcpUploadClaims.key })
        .from(mcpUploadClaims)
        .where(
          and(eq(mcpUploadClaims.key, key), gt(mcpUploadClaims.expiresAt, now)),
        )
        .get() !== undefined
    );
  },

  /** Claim `key` until `expiresAt`: true when this call claimed it, false when it was taken. */
  claim(db: Database, key: string, expiresAt: number, now: number) {
    return db.transaction((tx) => {
      tx.delete(mcpUploadClaims)
        .where(lte(mcpUploadClaims.expiresAt, now))
        .run();
      return (
        tx
          .insert(mcpUploadClaims)
          .values({ key, expiresAt })
          .onConflictDoNothing()
          .returning({ claimed: mcpUploadClaims.key })
          .all().length === 1
      );
    });
  },

  /** Give back a claim whose upload committed nothing. */
  release(db: Database, key: string) {
    db.delete(mcpUploadClaims).where(eq(mcpUploadClaims.key, key)).run();
  },
} as const;
