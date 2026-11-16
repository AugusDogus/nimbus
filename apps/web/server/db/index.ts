import { Database as SQLite } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { databaseFile, getConfigRoot, getDatabaseUrl } from "../storage-paths";
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

const stateDirectory = getConfigRoot();
mkdirSync(stateDirectory, { recursive: true });

declare global {
  var nimbusDatabase: ReturnType<typeof openDatabase> | undefined;
}
const opened =
  globalThis.nimbusDatabase ?? openDatabase(databaseFile(getDatabaseUrl()));
// Next bundles route handlers separately from the custom server; share one connection.
globalThis.nimbusDatabase = opened;
export const client = opened.sqlite;
export const db: Database = opened.db;
