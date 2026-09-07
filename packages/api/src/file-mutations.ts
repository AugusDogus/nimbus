import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { getDataRoot } from "./data-root";
import { isWithinPath } from "./safe-path";

type FileLock = { token: string; userId: string; expiresAt: number };
type MutationState = { tail: Promise<void>; locks: Map<string, FileLock> };

// Next bundles API handlers separately from the custom server. Keep one coordinator per
// mounted drive in this process so browser mutations respect WebDAV locks too.
declare global {
  var nimbusFileMutations: Map<string, MutationState> | undefined;
}
function state() {
  const states = (globalThis.nimbusFileMutations ??= new Map());
  const root = getDataRoot();
  let current = states.get(root);
  if (!current) {
    current = { tail: Promise.resolve(), locks: new Map() };
    states.set(root, current);
  }
  for (const [path, lock] of current.locks)
    if (lock.expiresAt <= Date.now()) current.locks.delete(path);
  return current;
}

export class FileLockedError extends TRPCError {
  constructor() {
    super({
      code: "CONFLICT",
      message:
        "This item is locked by a WebDAV client. Unlock it there or wait for its lock to expire.",
    });
    this.name = "FileLockedError";
  }
}

export type MutationCredentials = {
  userId: string;
  lockTokens?: readonly string[];
};
export function requireUnlocked(
  paths: readonly string[],
  credentials: MutationCredentials,
) {
  for (const [lockedPath, lock] of state().locks) {
    if (
      !paths.some(
        (path) =>
          isWithinPath(lockedPath, path) || isWithinPath(path, lockedPath),
      )
    )
      continue;
    if (
      lock.userId !== credentials.userId ||
      !credentials.lockTokens?.includes(lock.token)
    )
      throw new FileLockedError();
  }
}

/** Serialize short filesystem commits, never the network transfer preceding an upload. */
export async function mutateFiles<T>(
  paths: readonly string[],
  credentials: MutationCredentials,
  operation: () => Promise<T>,
): Promise<T> {
  const current = state();
  const previous = current.tail;
  let release = () => {};
  current.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    requireUnlocked(paths, credentials);
    return await operation();
  } finally {
    release();
  }
}

export function lockFile(path: string, credentials: MutationCredentials) {
  const current = state();
  const existing = current.locks.get(path);
  if (existing) {
    requireUnlocked([path], credentials);
    existing.expiresAt = Date.now() + 60 * 60 * 1000;
    return existing;
  }
  requireUnlocked([path], credentials);
  if (current.locks.size >= 1000)
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message:
        "Too many active file locks. Release an existing WebDAV lock and try again.",
    });
  const lock = {
    token: `opaquelocktoken:${randomUUID()}`,
    userId: credentials.userId,
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
  current.locks.set(path, lock);
  return lock;
}

export function unlockFile(path: string, userId: string, token: string) {
  const current = state();
  const lock = current.locks.get(path);
  if (!lock || lock.userId !== userId || token !== `<${lock.token}>`)
    throw new TRPCError({
      code: "CONFLICT",
      message: "This WebDAV lock no longer exists or its token does not match.",
    });
  current.locks.delete(path);
}

/** A lock ends when DELETE or MOVE removes its root URL (RFC 4918, section 6.1). */
export function forgetFileLocks(path: string) {
  const current = state();
  for (const lockedPath of current.locks.keys())
    if (isWithinPath(path, lockedPath)) current.locks.delete(lockedPath);
}

export function fileLock(path: string) {
  return state().locks.get(path);
}

/** Extract positive token conditions. A negated token never authorizes a write. */
export function webDAVLockTokens(header: string | null): string[] {
  const tokens: string[] = [];
  for (const list of (header ?? "").matchAll(/\(([^)]*)\)/g)) {
    for (const condition of (list[1] ?? "").matchAll(
      /(Not\s+)?<(opaquelocktoken:[a-f0-9-]+)>/gi,
    )) {
      if (!condition[1] && condition[2]) tokens.push(condition[2]);
    }
  }
  return tokens;
}
