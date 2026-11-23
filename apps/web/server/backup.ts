import {
  chmod,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { ExclusiveFile } from "./exclusive-file";
import { databaseFile, getConfigRoot, getDatabaseUrl } from "./storage-paths";

/**
 * Online SQLite backups.
 *
 * `VACUUM INTO` writes a consistent, compacted snapshot while the server keeps
 * serving reads and writes. It runs in a separate Bun process: SQLite would
 * otherwise block this process's event loop for the whole copy, and opening
 * the database a second time inside this process risks dropping its locks.
 */
export type BackupFile = { name: string; size: number; createdAt: number };
export type BackupOptions = {
  databaseUrl: string;
  /** Directory holding completed backups, created with owner-only access. */
  directory: string;
  /** Completed backups to keep, newest first. */
  keep: number;
  now?: number;
};

const backupName = /^nimbus-(\d{8}T\d{6}Z)\.sqlite$/;

// Runs in its own process with Bun's built-in SQLite, so it needs no package
// resolution and never shares this process's file locks.
const snapshotScript = `
const { Database } = require("bun:sqlite");
const [source, destination] = process.argv.slice(-2);
const database = new Database(source, { readonly: true });
try {
  database.run("PRAGMA busy_timeout = 5000");
  database.query("VACUUM INTO ?").run(destination);
} finally {
  database.close();
}
const copy = new Database(destination, { readonly: true });
try {
  const [check] = copy.query("PRAGMA quick_check").values();
  if (check?.[0] !== "ok") throw new Error("The snapshot failed its integrity check: " + JSON.stringify(check));
} finally {
  copy.close();
}
`;

function stamp(now: number) {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

async function snapshot(databaseUrl: string, destination: string) {
  if (!databaseUrl.startsWith("file:"))
    throw new Error(
      `Backups need a local SQLite database, but DATABASE_URL is "${databaseUrl}". Use a file: URL or back up the remote database with its own tools.`,
    );
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      snapshotScript,
      databaseFile(databaseUrl),
      destination,
    ],
    { stdout: "ignore", stderr: "pipe", env: { ...process.env } },
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(
      `The database snapshot process exited with code ${code}. Earlier backups are unchanged. ${stderr.trim().slice(-2000)}`,
    );
}

async function list(directory: string): Promise<BackupFile[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
  const backups = await Promise.all(
    names
      .filter((name) => backupName.test(name))
      .map(async (name) => {
        const details = await stat(path.join(directory, name));
        return { name, size: details.size, createdAt: details.mtimeMs };
      }),
  );
  return backups.sort((a, b) => (a.name < b.name ? 1 : -1));
}

async function create({
  databaseUrl,
  directory,
  keep,
  now = Date.now(),
}: BackupOptions) {
  if (!Number.isInteger(keep) || keep < 1)
    throw new Error(
      `Backups to keep must be a positive whole number, not ${keep}.`,
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // One backup at a time across every server process: a new server's backup before its
  // migrations can start while the server it replaces runs its scheduled one.
  const lock = await holdBackupLock(directory);
  try {
    return await createHeld(databaseUrl, directory, keep, now);
  } finally {
    lock.release();
  }
}

/** How long a backup waits for another process's to finish before it gives up. */
const backupLockWaitMs = 30 * 60 * 1000;

/**
 * The backups directory's lock, waited for without blocking the event loop: the lock is tried
 * every quarter second rather than with SQLite's own busy wait, which would stall the server.
 */
async function holdBackupLock(directory: string) {
  // Beside the directory, so listings of the backups never show it.
  const file = `${directory}.lock`;
  const until = Date.now() + backupLockWaitMs;
  for (;;) {
    const held = ExclusiveFile.acquire(file);
    if (held.ok) return held.value;
    if (held.error.kind === "unavailable")
      throw new Error(
        `Nimbus could not lock its backups at ${file} (${held.error.reason}). Earlier backups are unchanged. Check that the config root is writable.`,
      );
    if (Date.now() > until)
      throw new Error(
        `Another Nimbus server has been backing up the database for over ${backupLockWaitMs / 60_000} minutes, so this backup gave up. Earlier backups are unchanged; it is tried again later.`,
      );
    await Bun.sleep(250);
  }
}

async function createHeld(
  databaseUrl: string,
  directory: string,
  keep: number,
  now: number,
) {
  const name = `nimbus-${stamp(now)}.sqlite`;
  const completed = path.join(directory, name);
  const partial = `${completed}.partial`;
  // One backup runs at a time, so any partial file is left from an interrupted one.
  for (const leftover of await readdir(directory))
    if (leftover.endsWith(".sqlite.partial"))
      await rm(path.join(directory, leftover), { force: true });
  try {
    await snapshot(databaseUrl, partial);
    await chmod(partial, 0o600);
    const handle = await open(partial, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Only complete files carry the final name, and rename replaces atomically.
    await rename(partial, completed);
    const folder = await open(directory, "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } finally {
    await rm(partial, { force: true });
  }
  for (const old of (await list(directory)).slice(keep))
    await rm(path.join(directory, old.name), { force: true });
  const details = await stat(completed);
  return {
    name,
    size: details.size,
    createdAt: details.mtimeMs,
  } satisfies BackupFile;
}

/** The absolute path of a completed backup, or null for any other name. */
function file(directory: string, name: string) {
  return backupName.test(name) ? path.join(directory, name) : null;
}

/**
 * Serialize backups in this process: scheduled and manual requests share one
 * running job instead of competing for disk bandwidth.
 */
function scheduler(
  options: () => Omit<BackupOptions, "now">,
  intervalMs: number,
) {
  let running: Promise<BackupFile> | undefined;
  const run = () => {
    running ??= create(options()).finally(() => {
      running = undefined;
    });
    return running;
  };
  return {
    run,
    /** Back up when the newest backup is older than the interval. */
    async runIfDue(now = Date.now()) {
      const [latest] = await list(options().directory);
      if (latest && now - latest.createdAt < intervalMs) return null;
      return run();
    },
  };
}

export const Backup = { create, list, file, scheduler } as const;

let scheduled: ReturnType<typeof scheduler> | null = null;

/** Completed backups to keep, from NIMBUS_BACKUP_KEEP (default 7). */
export function backupsToKeep(value = process.env.NIMBUS_BACKUP_KEEP) {
  if (value === undefined || value === "") return 7;
  const keep = Number(value);
  if (!Number.isInteger(keep) || keep < 1)
    throw new Error(
      `NIMBUS_BACKUP_KEEP must be a whole number of at least 1, not "${value}". Set it to how many daily database backups to keep.`,
    );
  return keep;
}

/** The process-wide daily backup job, shared by the scheduler and Back up now. */
export function backups() {
  scheduled ??= scheduler(
    () => ({
      databaseUrl: getDatabaseUrl(),
      directory: path.join(getConfigRoot(), "backups"),
      keep: backupsToKeep(),
    }),
    24 * 60 * 60 * 1000,
  );
  return scheduled;
}
