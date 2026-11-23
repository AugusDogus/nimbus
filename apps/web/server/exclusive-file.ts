import { Database } from "bun:sqlite";

/**
 * An exclusive lock on a file, held until released or until the process ends, however it ends:
 * the operating system drops it with the process. It is SQLite's own file lock, on a small
 * database file of its own, so it works wherever Nimbus's database does, across processes and
 * across containers that share the directory. Within one process a second holder is refused
 * too.
 */
export type ExclusiveFile = { release: () => void };

/**
 * Connections holding a lock. Nothing else may need to refer to a lock held for a process's
 * whole life, and a connection nobody refers to is collected, which would close it and drop the
 * lock, so each stays here until released.
 */
const holding = new Set<Database>();

export type ExclusiveFileError =
  | { kind: "held"; file: string }
  | { kind: "unavailable"; file: string; reason: string };

function acquire(
  file: string,
  /** How long to wait for another holder to release it. */
  waitMs = 0,
):
  | { ok: true; value: ExclusiveFile }
  | { ok: false; error: ExclusiveFileError } {
  let database: Database;
  try {
    database = new Database(file, { create: true });
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "unavailable",
        file,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
  try {
    database.run(`PRAGMA busy_timeout = ${Math.max(0, Math.round(waitMs))}`);
    // Kept after the transaction starts, so the lock lasts until the connection closes.
    database.run("PRAGMA locking_mode = EXCLUSIVE");
    database.run("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    const busy =
      error instanceof Error &&
      /database is locked|SQLITE_BUSY/i.test(
        `${error.message} ${"code" in error ? String(error.code) : ""}`,
      );
    return {
      ok: false,
      error: busy
        ? { kind: "held", file }
        : {
            kind: "unavailable",
            file,
            reason: error instanceof Error ? error.message : String(error),
          },
    };
  }
  holding.add(database);
  let released = false;
  return {
    ok: true,
    value: {
      release() {
        if (released) return;
        released = true;
        holding.delete(database);
        database.run("ROLLBACK");
        database.close();
      },
    },
  };
}

export const ExclusiveFile = { acquire } as const;
