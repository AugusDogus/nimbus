import type { Database as SQLite } from "bun:sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { fileURLToPath } from "node:url";
import type { Database } from "./connection";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

/**
 * Apply committed migrations and switch to WAL. Foreign keys are off while
 * migrations run: SQLite ignores the pragma inside the migrator's transaction,
 * so a table rebuild would otherwise cascade deletes into child tables.
 */
export function migrateDatabase(sqlite: SQLite, db: Database) {
  sqlite.run("PRAGMA foreign_keys = OFF");
  try {
    migrate(db, { migrationsFolder });
  } finally {
    sqlite.run("PRAGMA foreign_keys = ON");
  }
  const violations = sqlite.query("PRAGMA foreign_key_check").all();
  if (violations.length)
    throw new Error(
      `Nimbus migrations left ${violations.length} rows that reference missing records. The database was migrated but Nimbus will not start on it; restore the backup taken before upgrading and report the failing migration.`,
    );
  // WAL lets online backups read a snapshot while requests keep writing. The
  // mode is stored in the database file, so this applies to every connection.
  sqlite.run("PRAGMA journal_mode = WAL");
}
