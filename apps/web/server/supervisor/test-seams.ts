import { existsSync } from "node:fs";
import path from "node:path";

/**
 * What the real-process tests inject into a supervisor and its installer, honoured only when they
 * run from a source checkout (the built-in release's root holds `.git`), never from an image or
 * an installed release, which have none:
 *
 * - NIMBUS_TEST_RELEASES_DIR: unsigned releases a restart may name, as `restart <name>`, beside
 *   the installed ones. Never chosen by a rollback or at boot.
 * - NIMBUS_TEST_RELEASE_KEYS_FILE: the release keys to trust instead of the image's.
 * - NIMBUS_TEST_STORE_DIR: the update store instead of the image's /var/lib/nimbus.
 * - NIMBUS_TEST_UPDATES_WITH_ONE_USER=1: updates on although every process runs as one user.
 *
 * Elsewhere they are refused, with `refused` saying so once.
 */
export type TestSeams = {
  releasesDir: string | null;
  keysFile: string | null;
  storeDir: string | null;
  oneUserUpdates: boolean;
  refused: string | null;
};

const names = {
  releasesDir: "NIMBUS_TEST_RELEASES_DIR",
  keysFile: "NIMBUS_TEST_RELEASE_KEYS_FILE",
  storeDir: "NIMBUS_TEST_STORE_DIR",
  oneUserUpdates: "NIMBUS_TEST_UPDATES_WITH_ONE_USER",
} as const;

export const TestSeams = {
  names,

  fromEnvironment(
    env: Record<string, string | undefined>,
    builtInRoot: string,
  ): TestSeams {
    const releasesDir = env[names.releasesDir] || null;
    const keysFile = env[names.keysFile] || null;
    const storeDir = env[names.storeDir] || null;
    const oneUserUpdates = env[names.oneUserUpdates] === "1";
    if (existsSync(path.join(builtInRoot, ".git")))
      return { releasesDir, keysFile, storeDir, oneUserUpdates, refused: null };
    const set = Object.values(names).filter((name) => env[name]);
    return {
      releasesDir: null,
      keysFile: null,
      storeDir: null,
      oneUserUpdates: false,
      refused: set.length
        ? `${set.join(", ")} ${set.length > 1 ? "are" : "is"} for tests in a source checkout and ignored here: only the image's release keys and update store are used, and only installed releases start.`
        : null,
    };
  },
} as const;
