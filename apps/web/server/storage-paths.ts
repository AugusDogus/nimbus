import { existsSync } from "node:fs";
import path from "node:path";
import { getDataRoot } from "@nimbus/api/data-root";

export function getConfigRoot(dataRoot = getDataRoot()) {
  const root = path.resolve(
    process.env.NIMBUS_CONFIG_ROOT ?? path.join(dataRoot, ".nimbus"),
  );
  const relative = path.relative(dataRoot, root);
  const inside =
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
  if (inside && relative.split(path.sep)[0] !== ".nimbus") {
    throw new Error(
      "Set NIMBUS_CONFIG_ROOT outside the data root or inside its reserved .nimbus directory so application state cannot be browsed or shared.",
    );
  }
  return root;
}

export function getDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const database = path.join(getConfigRoot(), "db.sqlite");
  const legacy = path.join(getDataRoot(), ".nimbus", "db.sqlite");
  if (database !== legacy && !existsSync(database) && existsSync(legacy)) {
    throw new Error(
      `An existing Nimbus database was found at ${legacy}, but ${database} is missing. Stop Nimbus and copy the database and any SQLite journal files into the config directory before restarting, or set DATABASE_URL to the existing database. Existing accounts and files are unchanged. See README's storage migration instructions.`,
    );
  }
  return `file:${database}`;
}

/** The local SQLite file named by a `file:` database URL. */
export function databaseFile(databaseUrl: string) {
  const match = /^file:(?:\/\/)?([^?]+)/.exec(databaseUrl);
  if (!match?.[1])
    throw new Error(
      `Nimbus needs a local SQLite database, but DATABASE_URL is "${databaseUrl}". Set it to a file: URL with an absolute path, for example file:/config/db.sqlite.`,
    );
  return decodeURIComponent(match[1]);
}
