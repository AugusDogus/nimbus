import { subscribeFileEvents } from "@nimbus/api/file-events";
import { auth } from "@/lib/auth";
import { db } from "../db";
import { reconcileIntervalMs } from "../search-protocol";
import { driveStore } from "../services";
import { LibraryCatalog } from "./library-catalog";
import { PairingOrigin, type LibraryContext } from "./library-context";

/** The library API's dependencies from the environment. */
export function libraryRuntime(): LibraryContext {
  return {
    db,
    drive: driveStore,
    origin: PairingOrigin.read(),
    secret: process.env.BETTER_AUTH_SECRET ?? "",
    now: Date.now,
    getSession: async (headers) => {
      const session = await auth.api.getSession({ headers });
      return session
        ? {
            userId: session.user.id,
            sessionId: session.session.id,
            impersonatedBy: session.session.impersonatedBy ?? null,
          }
        : null;
    },
  };
}

const logFailure = (error: unknown) =>
  console.error(
    `Nimbus could not reconcile the library catalogs: ${error instanceof Error ? error.name : typeof error}. Paired devices see changes at their next library request.`,
  );

/**
 * Keep library catalogs in step with the drive: reconcile them now, again whenever the file
 * watcher reports a change inside one, and on the search index's reconcile interval.
 */
export function watchLibraryCatalogs() {
  const ctx = libraryRuntime();
  void LibraryCatalog.reconcileAll(ctx).catch(logFailure);
  subscribeFileEvents((event) => LibraryCatalog.noteChange(ctx, event.path));
  setInterval(
    () => void LibraryCatalog.reconcileAll(ctx).catch(logFailure),
    reconcileIntervalMs(),
  ).unref();
}
