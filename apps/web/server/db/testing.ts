import { migrateDatabase } from "./migrate-database";
import { openDatabase } from "./connection";

/** A migrated in-memory database with Nimbus's connection settings. */
export function createTestDatabase() {
  const opened = openDatabase(":memory:");
  migrateDatabase(opened.sqlite, opened.db);
  return opened;
}
