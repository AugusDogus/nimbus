import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { getDataRoot } from "@nimbus/api/data-root";

const within = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

/** `target` with symbolic links resolved in the part that exists. */
function physical(target: string): string {
  try {
    return realpathSync.native(target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    const parent = path.dirname(target);
    return parent === target
      ? target
      : path.join(physical(parent), path.basename(target));
  }
}

function checkConfigRoot(dataRoot: string, root: string) {
  if (
    within(dataRoot, root) &&
    path.relative(dataRoot, root).split(path.sep)[0] !== ".nimbus"
  )
    throw new Error(
      `NIMBUS_CONFIG_ROOT (${root}) is inside the data root (${dataRoot}). Set it outside the data root or inside its reserved .nimbus directory so application state cannot be browsed or shared.`,
    );
  if (root === path.parse(root).root || within(root, dataRoot))
    throw new Error(
      `NIMBUS_CONFIG_ROOT (${root}) is the filesystem root or contains the data root (${dataRoot}). Point it at a separate directory used only by Nimbus, such as /config. Nothing was changed.`,
    );
}

/**
 * The directory for Nimbus's own state. The container entrypoint applies the same rule before
 * it gives this directory to PUID:PGID (scripts/docker-entrypoint.sh, check_roots): to the
 * paths as written and to the directories symbolic links lead to.
 */
export function getConfigRoot(dataRoot = getDataRoot()) {
  const configured = process.env.NIMBUS_CONFIG_ROOT;
  if (configured === "")
    throw new Error(
      "NIMBUS_CONFIG_ROOT is empty. Unset it to keep state in <data root>/.nimbus, or set it to a directory used only by Nimbus. Nothing was changed.",
    );
  const root = path.resolve(configured ?? path.join(dataRoot, ".nimbus"));
  checkConfigRoot(dataRoot, root);
  checkConfigRoot(physical(dataRoot), physical(root));
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
