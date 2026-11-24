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
 *
 * Elsewhere they are refused, with `refused` saying so once.
 */
export type TestSeams = {
  releasesDir: string | null;
  keysFile: string | null;
  refused: string | null;
};

const names = {
  releasesDir: "NIMBUS_TEST_RELEASES_DIR",
  keysFile: "NIMBUS_TEST_RELEASE_KEYS_FILE",
} as const;

export const TestSeams = {
  names,

  fromEnvironment(
    env: Record<string, string | undefined>,
    builtInRoot: string,
  ): TestSeams {
    const releasesDir = env[names.releasesDir] || null;
    const keysFile = env[names.keysFile] || null;
    if (existsSync(path.join(builtInRoot, ".git")))
      return { releasesDir, keysFile, refused: null };
    const set = Object.values(names).filter((name) => env[name]);
    return {
      releasesDir: null,
      keysFile: null,
      refused: set.length
        ? `${set.join(" and ")} ${set.length > 1 ? "are" : "is"} for tests in a source checkout and ignored here: only the image's release keys are trusted, and only installed releases start.`
        : null,
    };
  },
} as const;
