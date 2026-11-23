import { gt, inArray, lte, eq } from "drizzle-orm";
import type { FileLock, FileLockStore } from "@nimbus/api/file-mutations";
import type { Database } from "./db";
import { davLocks } from "./db/schema";

/**
 * WebDAV locks kept in the database, so a lock granted by one server process is honoured by the
 * next one an update starts, and by every process running meanwhile. Reads and writes are
 * synchronous, as lock checks inside a held path scope need. Expired rows are deleted whenever a
 * lock is added.
 */
export const DavLockStore = {
  create(db: Database): FileLockStore {
    return {
      active(now) {
        return db
          .select()
          .from(davLocks)
          .where(gt(davLocks.expiresAt, now))
          .all()
          .map((row): FileLock => ({
            path: row.path,
            token: row.token,
            userId: row.userId,
            scope: row.scope,
            depth: row.depth,
            owner: row.owner,
            timeoutSeconds: row.timeoutSeconds,
            expiresAt: row.expiresAt,
          }));
      },
      add(lock) {
        db.transaction((tx) => {
          tx.delete(davLocks).where(lte(davLocks.expiresAt, Date.now())).run();
          tx.insert(davLocks).values(lock).run();
        });
      },
      refresh(token, timeoutSeconds, expiresAt) {
        db.update(davLocks)
          .set({ timeoutSeconds, expiresAt })
          .where(eq(davLocks.token, token))
          .run();
      },
      remove(tokens) {
        if (tokens.length)
          db.delete(davLocks)
            .where(inArray(davLocks.token, [...tokens]))
            .run();
      },
    };
  },
} as const;
