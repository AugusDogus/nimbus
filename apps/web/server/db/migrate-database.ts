import type { Database as SQLite } from "bun:sqlite";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";

const defaultMigrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
/** Drizzle's history table, so databases migrated by drizzle-kit stay compatible. */
const historyTable = "__drizzle_migrations";

export type MigrationOptions = { migrationsFolder?: string };

/** Migrations newer than the last one recorded, as Drizzle's migrator decides. */
function pendingMigrations(
  sqlite: SQLite,
  migrationsFolder: string,
): MigrationMeta[] {
  const migrations = readMigrationFiles({ migrationsFolder });
  const history = sqlite
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(historyTable);
  if (!history) return migrations;
  const last = sqlite
    .query<{ created_at: number | string }, []>(
      `SELECT created_at FROM "${historyTable}" ORDER BY created_at DESC LIMIT 1`,
    )
    .get();
  return last
    ? migrations.filter(
        (migration) => Number(last.created_at) < migration.folderMillis,
      )
    : migrations;
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
  const pending = pendingMigrations(sqlite, migrationsFolder);
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
