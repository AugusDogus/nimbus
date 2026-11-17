import { Database as SQLite } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export type Database = BunSQLiteDatabase<typeof schema>;

/**
 * Open a SQLite database with Nimbus's connection settings. Queries run in
 * process and synchronously; transactions must be synchronous callbacks.
 */
export function openDatabase(filename: string) {
  const sqlite = new SQLite(filename, { create: true });
  // Waits for the separate backup and migration processes, never for this one.
  sqlite.run("PRAGMA busy_timeout = 5000");
  sqlite.run("PRAGMA foreign_keys = ON");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
