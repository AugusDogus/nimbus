import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { getDataRoot } from "./data-root";
import { isWithinPath } from "./safe-path";

/** `0` protects a collection and its membership but not its members' content (RFC 4918, section 7). */
export type LockDepth = "0" | "infinity";
/** Shared locks coexist with each other; an exclusive lock excludes every other lock. */
export type LockScope = "exclusive" | "shared";
export type FileLock = {
  path: string;
  token: string;
  userId: string;
  scope: LockScope;
  depth: LockDepth;
  /** The client's DAV:owner element, serialized, echoed back in lock discovery. */
  owner: string;
  timeoutSeconds: number;
  expiresAt: number;
};
/** Active locks by token. */
type MutationState = { tail: Promise<void>; locks: Map<string, FileLock> };

/** Locks never outlive a client that stops refreshing them by more than this. */
export const maxLockSeconds = 60 * 60;

const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** Whether a lock's scope includes a resource, so its token may be used there. */
export const lockCovers = (lock: FileLock, path: string) =>
  lock.path === path ||
  (lock.depth === "infinity" && isWithinPath(lock.path, path));

/** Whether changing `path` alters something the lock protects (RFC 4918, sections 6 and 7). */
function lockProtects(lock: FileLock, path: string) {
  // Moving or deleting an ancestor removes the locked resource.
  if (isWithinPath(path, lock.path)) return true;
  if (lock.depth === "infinity") return isWithinPath(lock.path, path);
  // A depth-0 collection lock protects its membership. Paths do not say whether a write
  // creates a member or changes one, so writes to every direct member are protected.
  return path !== "" && parentOf(path) === lock.path;
}

// Next bundles API handlers separately from the custom server. Keep one coordinator per
// mounted drive in this process so browser mutations respect WebDAV locks too.
declare global {
  var nimbusFileMutations: Map<string, MutationState> | undefined;
}
function state() {
  const states = (globalThis.nimbusFileMutations ??= new Map<string, MutationState>());
  const root = getDataRoot();
  let current = states.get(root);
  if (!current) {
    current = { tail: Promise.resolve(), locks: new Map() };
    states.set(root, current);
  }
  for (const [token, lock] of current.locks)
    if (lock.expiresAt <= Date.now()) current.locks.delete(token);
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
/**
 * Refuse a change to locked resources unless the user submits a token they own: for every
 * exclusive lock involved, and for at least one of the shared locks protecting each path.
 */
export function requireUnlocked(
  paths: readonly string[],
  credentials: MutationCredentials,
) {
  const submitted = (lock: FileLock) =>
    lock.userId === credentials.userId &&
    (credentials.lockTokens?.includes(lock.token) ?? false);
  const locks = [...state().locks.values()];
  for (const path of paths) {
    const protecting = locks.filter((lock) => lockProtects(lock, path));
    const shared = protecting.filter((lock) => lock.scope === "shared");
    if (
      protecting.some((lock) => lock.scope === "exclusive" && !submitted(lock)) ||
      (shared.length > 0 && !shared.some(submitted))
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

export type LockRequest = {
  scope: LockScope;
  depth: LockDepth;
  owner: string;
  timeoutSeconds: number;
};

/** Create a write lock. Locks with overlapping scopes conflict unless both are shared. */
export function lockFile(
  path: string,
  credentials: MutationCredentials,
  request: LockRequest = { scope: "exclusive", depth: "infinity", owner: "", timeoutSeconds: maxLockSeconds },
) {
  const current = state();
  for (const lock of current.locks.values())
    if (
      (lockCovers(lock, path) ||
        (request.depth === "infinity" && isWithinPath(path, lock.path))) &&
      (lock.scope === "exclusive" || request.scope === "exclusive")
    )
      throw new FileLockedError();
  if (current.locks.size >= 1000)
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message:
        "Too many active file locks. Release an existing WebDAV lock and try again.",
    });
  const lock: FileLock = {
    path,
    token: `opaquelocktoken:${randomUUID()}`,
    userId: credentials.userId,
    ...request,
    expiresAt: Date.now() + request.timeoutSeconds * 1000,
  };
  current.locks.set(lock.token, lock);
  return lock;
}

/** Extend a lock covering `path` whose token the owner submitted, or return null. */
export function refreshLock(
  path: string,
  credentials: MutationCredentials,
  timeoutSeconds: number,
) {
  for (const lock of state().locks.values()) {
    if (
      lock.userId !== credentials.userId ||
      !credentials.lockTokens?.includes(lock.token) ||
      !lockCovers(lock, path)
    )
      continue;
    lock.timeoutSeconds = timeoutSeconds;
    lock.expiresAt = Date.now() + timeoutSeconds * 1000;
    return lock;
  }
  return null;
}

/** Release a lock by its token from any URL within its scope. */
export function unlockFile(path: string, userId: string, token: string) {
  const current = state();
  const lock = current.locks.get(token.replace(/^<|>$/g, ""));
  if (lock && lock.userId === userId && token === `<${lock.token}>` && lockCovers(lock, path)) {
    current.locks.delete(lock.token);
    return;
  }
  throw new TRPCError({
    code: "CONFLICT",
    message:
      "This WebDAV lock no longer exists, belongs to someone else, or does not cover this item. Refresh the client's view and try again.",
  });
}

/** A lock ends when DELETE or MOVE removes its root URL (RFC 4918, section 6.1). */
export function forgetFileLocks(path: string) {
  const current = state();
  for (const [token, lock] of current.locks)
    if (isWithinPath(path, lock.path)) current.locks.delete(token);
}

/** Active locks whose scope includes a resource. */
export function locksCovering(path: string) {
  return [...state().locks.values()].filter((lock) => lockCovers(lock, path));
}
