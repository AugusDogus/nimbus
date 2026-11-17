import { TRPCError } from "@trpc/server";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getDataRoot } from "./data-root";
import { createPathLocks, type HeldScope, type PathLocks } from "./path-locks";
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
/** Who is changing what, and the active WebDAV locks by token. */
type MutationState = { scopes: PathLocks; locks: Map<string, FileLock> };

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

/**
 * One coordinator per data root, shared by the browser API, WebDAV and MCP, so every change
 * respects the same WebDAV locks. Keyed by root because tests point the process at a new
 * data root per test.
 */
const states = new Map<string, MutationState>();
function state() {
  const root = getDataRoot();
  let current = states.get(root);
  if (!current) {
    current = { scopes: createPathLocks(), locks: new Map() };
    states.set(root, current);
  }
  for (const [token, lock] of current.locks)
    if (lock.expiresAt <= Date.now()) current.locks.delete(token);
  return current;
}

/** Drop the coordinator of a data root a test has finished with. */
export function forgetFileMutationsForTest(root: string) {
  states.delete(root);
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
      protecting.some(
        (lock) => lock.scope === "exclusive" && !submitted(lock),
      ) ||
      (shared.length > 0 && !shared.some(submitted))
    )
      throw new FileLockedError();
  }
}

/** Checks of the request being served that every mutation it starts re-runs, holding its scope. */
const preconditions = new AsyncLocalStorage<() => Promise<void>>();

/**
 * Run `operation` so each mutation it starts runs `check` once it holds its paths, before
 * changing anything. A request's conditions, such as a WebDAV If header, then cannot pass
 * against a state another writer is about to change. `check` throws to refuse.
 */
export function withMutationPrecondition<T>(
  check: () => Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  return preconditions.run(check, operation);
}

/** What a mutation holds besides the paths it changes. */
export type MutationScope = {
  /** Subtrees held without a WebDAV lock check, such as a folder in which a free name is chosen. */
  within?: readonly string[];
  /** Trash items held by id, or "all" for the whole trash. */
  trash?: readonly string[] | "all";
};

/**
 * Run a short filesystem commit, never the network transfer preceding an
 * upload, while holding `paths` (and their subtrees) and `scope` exclusively.
 * Commits on disjoint paths run concurrently; overlapping ones run one at a
 * time in arrival order. WebDAV locks on `paths` are checked once the scope is
 * held, so a LOCK cannot slip in between the check and the change. Callers
 * re-check permissions inside `operation`.
 */
export async function mutateFiles<T>(
  paths: readonly string[],
  credentials: MutationCredentials,
  operation: () => Promise<T>,
  scope: MutationScope = {},
): Promise<T> {
  const held: HeldScope[] = [
    ...[...paths, ...(scope.within ?? [])].map((path) => ({
      space: "drive",
      path,
    })),
    ...(scope.trash === "all"
      ? [{ space: "trash", path: "" }]
      : (scope.trash ?? []).map((id) => ({ space: "trash", path: id }))),
  ];
  const [first, ...rest] = held;
  if (!first)
    throw new Error(
      "mutateFiles was called without a scope, so it would not exclude any concurrent change. Name the paths or trash items the operation changes; nothing was changed.",
    );
  const release = await state().scopes.acquire([first, ...rest]);
  try {
    requireUnlocked(paths, credentials);
    await preconditions.getStore()?.();
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

/** Active locks one user may hold, so one user cannot use up locks for everyone. */
const maxLocksPerUser = 1000;

/**
 * Throw what `lockFile` would for this request, without creating a lock: a conflicting lock,
 * or the user's lock limit. Run it before work a refused lock should not leave behind.
 */
export function requireLockable(
  path: string,
  credentials: MutationCredentials,
  request: Pick<LockRequest, "scope" | "depth"> = {
    scope: "exclusive",
    depth: "infinity",
  },
) {
  let held = 0;
  for (const lock of state().locks.values()) {
    if (
      (lockCovers(lock, path) ||
        (request.depth === "infinity" && isWithinPath(path, lock.path))) &&
      (lock.scope === "exclusive" || request.scope === "exclusive")
    )
      throw new FileLockedError();
    if (lock.userId === credentials.userId) held++;
  }
  if (held >= maxLocksPerUser)
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `You have ${maxLocksPerUser} active WebDAV locks, the most one account may hold. Unlock files in your WebDAV client, or wait up to an hour for its locks to expire, then try again.`,
    });
}

/** Create a write lock. Locks with overlapping scopes conflict unless both are shared. */
export function lockFile(
  path: string,
  credentials: MutationCredentials,
  request: LockRequest = {
    scope: "exclusive",
    depth: "infinity",
    owner: "",
    timeoutSeconds: maxLockSeconds,
  },
) {
  requireLockable(path, credentials, request);
  const current = state();
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
  if (
    lock &&
    lock.userId === userId &&
    token === `<${lock.token}>` &&
    lockCovers(lock, path)
  ) {
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
