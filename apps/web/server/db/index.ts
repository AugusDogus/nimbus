import { mkdirSync } from "node:fs";
import { databaseFile, getConfigRoot, getDatabaseUrl } from "../storage-paths";
import { openDatabase, type Database } from "./connection";

export { openDatabase, type Database } from "./connection";

// Opens the configured database on import. Tests use ./connection or ./testing instead.
const stateDirectory = getConfigRoot();
mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });

/** The SQLite file the server uses. */
export const databasePath = databaseFile(getDatabaseUrl());
const opened = openDatabase(databasePath);
export const client = opened.sqlite;
export const db: Database = opened.db;
