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

function locker(timeoutMs = 30_000): Locker {
  return {
    newLock(id: string): Lock {
      let release: (() => void) | null = null;
      return {
        async lock(signal, requestRelease) {
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
          if (given === null) {
            // Granted later after all: give it straight back.
            void granted.then((late) => late());
            throw ERRORS.ERR_LOCK_TIMEOUT;
          }
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
  };
}

/** Run `operation` holding upload `id`'s lock, as publishing a finished upload does. */
const hold = <T>(id: string, operation: () => Promise<T>) =>
  FileMutations.holdScopes([scope(id)], operation);

export const UploadLocks = { locker, hold } as const;
