import type { Database as SQLite } from "bun:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Whether a new server may apply its pending migrations while an older server still serves the
 * same database, as a restart without downtime runs them. Only additive migrations are safe so:
 * new tables, nullable or defaulted columns, indexes. One that renames, drops or rewrites what
 * older code reads breaks the older server for as long as both run.
 *
 * A release declares its safe migrations by tag in `drizzle/live-safe.json`
 * (`{ "safeBesideOlderServer": ["0016_…"] }`). Anything pending that it does not declare, or a
 * missing or unreadable declaration, means a full restart instead: the supervisor stops every
 * server, then starts the new one alone.
 */
export type MigrationGateResult =
  | { kind: "none" }
  | { kind: "safe"; pending: string[] }
  | { kind: "full-restart"; pending: string[]; reason: string };

const defaultFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

const journal = z.object({
  entries: z.array(z.object({ tag: z.string(), when: z.number() })),
});
const declaration = z.object({ safeBesideOlderServer: z.array(z.string()) });

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Tags of migrations newer than the last one the database recorded, as the migrator decides. */
function pendingTags(sqlite: SQLite, folder: string) {
  const entries = journal.parse(
    readJson(path.join(folder, "meta/_journal.json")),
  ).entries;
  const history = sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    )
    .get();
  const last = history
    ? sqlite
        .query<{ created_at: number | string }, []>(
          'SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
        )
        .get()
    : null;
  const since = last ? Number(last.created_at) : Number.NEGATIVE_INFINITY;
  return entries
    .filter((entry) => entry.when > since)
    .map((entry) => entry.tag);
}

/**
 * Whether the database holds migrations this release does not know, applied by a newer release:
 * `safe` when every one of them was declared safe beside an older server, as the release that
 * applied them recorded (see safetyTable), so this older release may run on it; `unsafe` when one
 * was not, or nothing says, so running would risk misreading or damaging data.
 */
export type NewerRelease =
  | { kind: "none" }
  | { kind: "safe"; migrations: string[] }
  | { kind: "unsafe"; migrations: string[] };

export const MigrationGate = {
  /** Compare the database's history with this release's journal (see NewerRelease). */
  newerRelease(sqlite: SQLite, folder = defaultFolder): NewerRelease {
    const history = sqlite
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
      )
      .get();
    if (!history) return { kind: "none" };
    const known = new Set(
      journal
        .parse(readJson(path.join(folder, "meta/_journal.json")))
        .entries.map((entry) => entry.when),
    );
    const applied = sqlite
      .query<{ created_at: number | string }, []>(
        'SELECT created_at FROM "__drizzle_migrations"',
      )
      .all()
      .map((row) => Number(row.created_at))
      .filter((when) => !known.has(when));
    if (!applied.length) return { kind: "none" };
    const recorded = sqlite
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nimbus_migration_safety'",
      )
      .get();
    const describe = (when: number) => {
      const row = recorded
        ? sqlite
            .query<{ tag: string; live_safe: number }, [number]>(
              "SELECT tag, live_safe FROM nimbus_migration_safety WHERE created_at = ?",
            )
            .get(when)
        : null;
      return {
        tag: row?.tag ?? `one applied at ${new Date(when).toISOString()}`,
        safe: row?.live_safe === 1,
      };
    };
    const newer = applied.map(describe);
    const migrations = newer.map((migration) => migration.tag);
    return newer.every((migration) => migration.safe)
      ? { kind: "safe", migrations }
      : { kind: "unsafe", migrations };
  },

  check(sqlite: SQLite, folder = defaultFolder): MigrationGateResult {
    const pending = pendingTags(sqlite, folder);
    if (!pending.length) return { kind: "none" };
    const declared = declaration.safeParse(
      readJson(path.join(folder, "live-safe.json")),
    );
    if (!declared.success)
      return {
        kind: "full-restart",
        pending,
        reason: `this release has ${pending.length} pending migrations and does not say which are safe beside an older server (drizzle/live-safe.json is missing or unreadable)`,
      };
    const safe = new Set(declared.data.safeBesideOlderServer);
    const unsafe = pending.filter((tag) => !safe.has(tag));
    return unsafe.length
      ? {
          kind: "full-restart",
          pending,
          reason: `its migrations ${unsafe.join(", ")} are not declared safe beside an older server`,
        }
      : { kind: "safe", pending };
  },
} as const;
