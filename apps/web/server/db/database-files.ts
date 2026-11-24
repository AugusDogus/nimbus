import type { Database as SQLite } from "bun:sqlite";
import { chmodSync, statSync } from "node:fs";

const companions = (file: string) => [file, `${file}-wal`, `${file}-shm`];
const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : null;

/**
 * Start a write transaction, write the header, and roll back. SQLite opens a file it cannot
 * write read-only without an error, and reads and `BEGIN IMMEDIATE` still succeed, so only a
 * write shows that every write would fail with SQLITE_READONLY.
 */
function probeWrite(sqlite: SQLite) {
  sqlite.run("BEGIN IMMEDIATE");
  try {
    const row = sqlite
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get();
    sqlite.run(`PRAGMA user_version = ${Number(row?.user_version ?? 0)}`);
  } finally {
    sqlite.run("ROLLBACK");
  }
}

/** Fail startup with recovery steps when the database cannot be written. */
function requireWritable(sqlite: SQLite, file: string) {
  try {
    probeWrite(sqlite);
  } catch (error) {
    throw new Error(
      `Nimbus cannot write to its database ${file} (${errorCode(error) ?? (error instanceof Error ? error.message : String(error))}). The file or its -wal and -shm companions probably belong to another user or sit on a read-only mount, for example after restoring a backup as root. Nothing was changed. Give ${companions(file).join(", ")} to the user Nimbus runs as (uid ${process.getuid?.() ?? "unknown"}), then restart.`,
      { cause: error },
    );
  }
}

function makePrivate(target: string, mode: number) {
  try {
    chmodSync(target, mode);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new Error(
      `Nimbus could not make ${target} private to its user (${errorCode(error) ?? (error instanceof Error ? error.message : String(error))}), so other local users might read account data. It probably belongs to another user, for example after a restore as root. Nothing was changed. Give it to the user Nimbus runs as (uid ${process.getuid?.() ?? "unknown"}), then restart.`,
      { cause: error },
    );
  }
}

/** Keep the database and its journal files owner-only, like backups, or stop startup. */
function restrict(file: string) {
  for (const target of companions(file)) makePrivate(target, 0o600);
}

/** Keep the config root, which holds the database and backups, owner-only, or stop startup. */
/**
 * Whether `stats` describe the config root the container entrypoint shares between Nimbus's
 * users (see docs/updates.md): not this user's, sticky, so nobody renames what another owns, and
 * closed to everyone outside its group except for passing through. It stays as it is; the
 * database and its journals inside are still made private.
 */
function sharedConfigRoot(stats: { uid: number; mode: number }, uid: number) {
  return (
    stats.uid !== uid &&
    (stats.mode & 0o1000) !== 0 &&
    (stats.mode & 0o006) === 0
  );
}

function restrictDirectory(directory: string) {
  let details: { uid: number; mode: number } | null = null;
  try {
    details = statSync(directory);
  } catch {
    details = null;
  }
  if (details && sharedConfigRoot(details, process.getuid?.() ?? -1)) return;
  makePrivate(directory, 0o700);
}

export const DatabaseFiles = {
  sharedConfigRoot,
  probeWrite,
  requireWritable,
  restrict,
  restrictDirectory,
} as const;
