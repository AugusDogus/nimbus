import path from "node:path";
import { ExclusiveFile } from "./exclusive-file";

/**
 * One Nimbus server per installation: the config root, which holds its database. Two servers
 * on one installation would each take the other's changes in progress for a crash's leftovers,
 * and grant path locks the other does not see. A server started on its own holds the lock for
 * its lifetime; under the supervisor the supervisor holds it, for every server it runs.
 *
 * Two installations with separate config roots that share one data root are not detected.
 */
export type InstallationLockError = {
  kind: "held" | "unavailable";
  message: string;
};

export const InstallationLock = {
  file: (configRoot: string) => path.join(configRoot, "server.lock"),

  acquire(
    configRoot: string,
  ):
    | { ok: true; value: ExclusiveFile }
    | { ok: false; error: InstallationLockError } {
    const file = InstallationLock.file(configRoot);
    const held = ExclusiveFile.acquire(file);
    if (held.ok) return held;
    return {
      ok: false,
      error:
        held.error.kind === "held"
          ? {
              kind: "held",
              message: `Another Nimbus server is using this installation (${configRoot}), so this one did not start: two servers on one database would undo each other's changes in progress. Stop the other server or container first. Nothing was changed.`,
            }
          : {
              kind: "unavailable",
              message: `Nimbus could not lock its installation at ${file} (${held.error.reason}), so it did not start. Check that the config root is writable. Nothing was changed.`,
            },
    };
  },
} as const;
