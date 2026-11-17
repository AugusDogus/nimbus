import { mkdirSync } from "node:fs";
import { databaseFile, getConfigRoot, getDatabaseUrl } from "../storage-paths";
import { openDatabase, type Database } from "./connection";

export { openDatabase, type Database } from "./connection";

// Opens the configured database on import. Tests use ./connection or ./testing instead.
const stateDirectory = getConfigRoot();
mkdirSync(stateDirectory, { recursive: true });

const opened = openDatabase(databaseFile(getDatabaseUrl()));
export const client = opened.sqlite;
export const db: Database = opened.db;
