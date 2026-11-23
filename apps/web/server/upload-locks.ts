import { ERRORS, type Lock, type Locker } from "@tus/server";
import { FileMutations } from "@nimbus/api/file-mutations";
import type { HeldScope } from "@nimbus/api/path-locks";

/**
 * One lock per tus upload, shared by both tus endpoints and, under the supervisor, by every
 * server process: it is a path scope (see `setScopeAuthority`). A PATCH still writing on a
 * server that is draining and a resumed PATCH on the next server therefore never both pass the
 * offset check or write to the staging file, and publishing a finished upload waits for both.
 *
 * As tus's own MemoryLocker, a newer request for an upload asks an older one in this process to
 * give the lock up; one on another server is waited for instead, up to `timeoutMs`, after which
 * the request fails and the client retries.
 */
const scope = (id: string): HeldScope => ({ space: "upload", path: id });

/** Locks held in this process, so a newer request can ask an older one to give up. */
const holders = new Map<string, () => Promise<void> | void>();

/**
 * Locks a request's `onIncomingRequest` took (see `holdThroughHandler`), each handed to the tus
 * handler of that request when it asks for the same upload's lock.
 */
const handedOver = new WeakMap<Request, Map<string, () => void>>();

/** Upload `id`'s lock, once any older holder in this process gave it up; null past the timeout. */
async function acquire(id: string, signal: AbortSignal, timeoutMs: number) {
  await holders.get(id)?.();
  const granted = FileMutations.acquireScopes([scope(id)]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => undefined;
  const given = await Promise.race([
    granted,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      onAbort = () => resolve(null);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
  clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);
  // Granted later after all: give it straight back.
  if (given === null) void granted.then((late) => late());
  return given;
}

function locker(timeoutMs = 30_000): (request: Request) => Locker {
  return (request) => ({
    newLock(id: string): Lock {
      let release: (() => void) | null = null;
      return {
        async lock(signal, requestRelease) {
          const held = handedOver.get(request);
          const taken = held?.get(id);
          held?.delete(id);
          const given = taken ?? (await acquire(id, signal, timeoutMs));
          if (given === null) throw ERRORS.ERR_LOCK_TIMEOUT;
          release = given;
          holders.set(id, requestRelease);
        },
        async unlock() {
          if (holders.get(id) && release) holders.delete(id);
          release?.();
          release = null;
        },
      };
    },
  });
}

/** Run `operation` holding upload `id`'s lock, as publishing a finished upload does. */
const hold = <T>(id: string, operation: () => Promise<T>) =>
  FileMutations.holdScopes([scope(id)], operation);

/**
 * Run `operation` holding upload `id`'s lock and keep holding it into the tus handler of
 * `request`, which runs next and takes it over: what `operation` decided from the upload, such
 * as that it is complete and published, then still holds when the handler reads it again.
 *
 * Call it last in `onIncomingRequest`: tus asks for the lock right after that hook returns,
 * with nothing in between but promise steps. A lock the handler did not take over by the next
 * turn of the event loop, as when the hook failed after this, is released then.
 */
async function holdThroughHandler<T>(
  request: Request,
  id: string,
  operation: () => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const release = await acquire(id, request.signal, timeoutMs);
  if (release === null) throw ERRORS.ERR_LOCK_TIMEOUT;
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    release();
    throw error;
  }
  const held = handedOver.get(request) ?? new Map<string, () => void>();
  held.set(id, release);
  handedOver.set(request, held);
  setTimeout(() => {
    if (held.get(id) !== release) return;
    held.delete(id);
    release();
  }, 0);
  return result;
}

export const UploadLocks = { locker, hold, holdThroughHandler } as const;
