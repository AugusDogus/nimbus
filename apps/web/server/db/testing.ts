import { migrateDatabase } from "./migrate-database";
import { openDatabase } from "./index";

/** A migrated in-memory database with Nimbus's connection settings. */
export function createTestDatabase() {
  const opened = openDatabase(":memory:");
  migrateDatabase(opened.sqlite, opened.db);
  return opened;
}
