import type { Database as SQLite } from "bun:sqlite";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultMigrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
/** Drizzle's history table, so databases migrated by drizzle-kit stay compatible. */
const historyTable = "__drizzle_migrations";
/**
 * Every migration a release knows, by Drizzle's timestamp, and whether that release declared it
 * safe beside an older server (drizzle/live-safe.json). An older release finds here whether a
 * migration it does not know was meant to run beside it (see MigrationGate.newerRelease).
 */
export const safetyTable = "nimbus_migration_safety";

/** The tags this folder declares safe beside an older server; none when it declares none. */
function liveSafeTags(migrationsFolder: string) {
  try {
    const declared: unknown = JSON.parse(
      readFileSync(path.join(migrationsFolder, "live-safe.json"), "utf8"),
    );
    return new Set(
      typeof declared === "object" &&
        declared !== null &&
        "safeBesideOlderServer" in declared &&
        Array.isArray(declared.safeBesideOlderServer)
        ? declared.safeBesideOlderServer.filter(
            (tag: unknown) => typeof tag === "string",
          )
        : [],
    );
  } catch {
    return new Set<string>();
  }
}

/** The folder's journal: each migration's tag and Drizzle timestamp. */
function journalOf(migrationsFolder: string): { tag: string; when: number }[] {
  try {
    const journal: unknown = JSON.parse(
      readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
    );
    if (
      typeof journal !== "object" ||
      journal === null ||
      !("entries" in journal)
    )
      return [];
    const entries: unknown = journal.entries;
    return Array.isArray(entries)
      ? entries.flatMap((entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          "tag" in entry &&
          "when" in entry &&
          typeof entry.tag === "string" &&
          typeof entry.when === "number"
            ? [{ tag: entry.tag, when: entry.when }]
            : [],
        )
      : [];
  } catch {
    return [];
  }
}

export type MigrationOptions = { migrationsFolder?: string };

/**
 * Migrations newer than the last one recorded, as Drizzle's migrator decides, and
 * whether the database already holds tables of its own. A database created by
 * db:push has tables but no history, so history alone does not tell.
 */
function migrationPlan(
  sqlite: SQLite,
  migrationsFolder: string,
): { pending: MigrationMeta[]; existing: boolean } {
  const migrations = readMigrationFiles({ migrationsFolder });
  const history = sqlite
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(historyTable);
  const last = history
    ? sqlite
        .query<{ created_at: number | string }, []>(
          `SELECT created_at FROM "${historyTable}" ORDER BY created_at DESC LIMIT 1`,
        )
        .get()
    : null;
  const existing =
    sqlite
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ? LIMIT 1",
      )
      .get(historyTable) !== null;
  if (!last) return { pending: migrations, existing };
  return {
    pending: migrations.filter(
      (migration) => Number(last.created_at) < migration.folderMillis,
    ),
    existing: true,
  };
}

/**
 * Snapshot an existing database with `snapshot`, which resolves to the backup's
 * name, before applying pending migrations. A new or current database is not
 * snapshotted, and nothing is migrated when the snapshot fails.
 */
export async function upgradeDatabase(
  sqlite: SQLite,
  snapshot: () => Promise<string>,
  { migrationsFolder = defaultMigrationsFolder }: MigrationOptions = {},
) {
  const { pending, existing } = migrationPlan(sqlite, migrationsFolder);
  if (existing && pending.length) {
    let backup: string;
    try {
      backup = await snapshot();
    } catch (error) {
      throw new Error(
        `Nimbus did not apply ${pending.length} pending database migrations because the backup before them failed, so the database is unchanged. Free space or fix permissions in the config directory's backups folder, then restart.`,
        { cause: error },
      );
    }
    console.info(
      `Nimbus backed up the database to ${backup} before applying ${pending.length} migrations.`,
    );
  }
  migrateDatabase(sqlite, { migrationsFolder });
}

/**
 * Apply committed migrations in one transaction and switch to WAL. Foreign keys
 * are off while migrations run: SQLite ignores the pragma inside a transaction,
 * so a table rebuild would otherwise cascade deletes into child tables. They are
 * checked before COMMIT instead, so a violating migration is never recorded.
 */
export function migrateDatabase(
  sqlite: SQLite,
  { migrationsFolder = defaultMigrationsFolder }: MigrationOptions = {},
) {
  sqlite.run(
    `CREATE TABLE IF NOT EXISTS "${historyTable}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
  sqlite.run(
    `CREATE TABLE IF NOT EXISTS "${safetyTable}" (created_at integer PRIMARY KEY, tag text NOT NULL, live_safe integer NOT NULL)`,
  );
  // What this release knows of every migration, for older releases to read; a later release's
  // own record of a migration it shares with this one is the same.
  const safe = liveSafeTags(migrationsFolder);
  const record = sqlite.prepare(
    `INSERT INTO "${safetyTable}" (created_at, tag, live_safe) VALUES (?, ?, ?) ON CONFLICT (created_at) DO UPDATE SET tag = excluded.tag, live_safe = excluded.live_safe`,
  );
  sqlite.transaction(() => {
    for (const entry of journalOf(migrationsFolder))
      record.run(entry.when, entry.tag, safe.has(entry.tag) ? 1 : 0);
  })();
  const { pending } = migrationPlan(sqlite, migrationsFolder);
  if (pending.length) {
    sqlite.run("PRAGMA foreign_keys = OFF");
    try {
      sqlite.run("BEGIN");
      try {
        for (const migration of pending) {
          for (const statement of migration.sql)
            if (statement.trim()) sqlite.run(statement);
          sqlite.run(
            `INSERT INTO "${historyTable}" ("hash", "created_at") VALUES (?, ?)`,
            [migration.hash, migration.folderMillis],
          );
        }
        const violations = sqlite.query("PRAGMA foreign_key_check").all();
        if (violations.length)
          throw new Error(
            `Nimbus migrations would leave ${violations.length} rows that reference missing records, so they were rolled back and the database is unchanged. Nimbus will not start until this is fixed; report the failing migration with the output of "PRAGMA foreign_key_check".`,
          );
        sqlite.run("COMMIT");
      } catch (error) {
        sqlite.run("ROLLBACK");
        throw error;
      }
    } finally {
      sqlite.run("PRAGMA foreign_keys = ON");
    }
  }
  // WAL lets online backups read a snapshot while requests keep writing. The
  // mode is stored in the database file, so this applies to every connection.
  sqlite.run("PRAGMA journal_mode = WAL");
}
