import {
  openTestDrive,
  type TestAccount,
  type TestDrive,
} from "../drive-testing";
import { LibraryCatalog } from "./library-catalog";
import type { BrowserSession, LibraryContext } from "./library-context";
import { LibraryThrottle } from "./library-throttle";

export const testOrigin = "https://nimbus.example.test";

/**
 * A library API context over a test drive: a fixed clock tests move with `advance`, and the
 * browser session `signIn` chooses, which the pairing page reads.
 */
export async function openLibraryTest() {
  const drive = await openTestDrive();
  LibraryThrottle.resetForTest();
  LibraryCatalog.resetForTest();
  let now = Date.UTC(2026, 10, 15, 12);
  let session: BrowserSession | null = null;
  let run = 1;
  const ctx: LibraryContext = {
    db: drive.db,
    drive: drive.store,
    origin: { kind: "configured", origin: testOrigin },
    secret: "test-secret-that-is-at-least-32-characters-long",
    now: () => now,
    run: () => `test-run-${run}`,
    getSession: async () => session,
  };
  return {
    drive,
    ctx,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
    /** Start another run of the server, as a restart would. */
    restart() {
      run++;
    },
    signIn(
      id: TestAccount,
      impersonatedBy: string | null = null,
    ): BrowserSession {
      session = { userId: id, sessionId: `session-${id}`, impersonatedBy };
      return session;
    },
    async close() {
      LibraryCatalog.resetForTest();
      await drive.close();
    },
  };
}
export type LibraryTest = Awaited<ReturnType<typeof openLibraryTest>>;
export type { TestDrive };
