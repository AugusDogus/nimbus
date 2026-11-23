import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { ExclusiveFile } from "./exclusive-file";

/**
 * One Nimbus server per installation: the config root, which holds its database. Two servers
 * on one installation would each take the other's changes in progress for a crash's leftovers,
 * and grant path locks the other does not see. A server started on its own holds the lock for
 * its lifetime; under the supervisor the supervisor holds it, for every server it runs.
 *
 * A server the supervisor runs also holds a lease of its own (`lease`), as long as it lives. A
 * supervisor that dies can leave its servers behind, draining, so whoever takes the lock next
 * waits for every lease to be free (`awaitLeases`) before starting a server.
 *
 * Two installations with separate config roots that share one data root are not detected.
 */
export type InstallationLockError = {
  kind: "held" | "unavailable";
  message: string;
};

export type LeaseError = { kind: "unavailable"; message: string };

const leases = (configRoot: string) => path.join(configRoot, "leases");
/** `<process id>.<pid>.lease`: the pid tells an operator which process still holds it. */
const leaseName = /^[\w-]+\.(\d+)\.lease$/;

/** Remove a lease file nobody holds, with the journal SQLite may leave beside it. */
function removeLease(file: string) {
  rmSync(file, { force: true });
  rmSync(`${file}-journal`, { force: true });
}

/** The pids of processes still holding a lease; free ones are removed. */
function heldLeases(
  configRoot: string,
): { ok: true; pids: number[] } | { ok: false; error: LeaseError } {
  let names: string[];
  try {
    names = readdirSync(leases(configRoot));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { ok: true, pids: [] };
    return {
      ok: false,
      error: {
        kind: "unavailable",
        message: `Nimbus could not list the leases in ${leases(configRoot)} (${error instanceof Error ? error.message : String(error)}), so it cannot tell whether server processes of an earlier start still run. Check that the config root is readable.`,
      },
    };
  }
  const pids: number[] = [];
  for (const name of names) {
    const pid = leaseName.exec(name)?.[1];
    if (pid === undefined) continue;
    const file = path.join(leases(configRoot), name);
    const free = ExclusiveFile.acquire(file);
    if (free.ok) {
      free.value.release();
      removeLease(file);
    } else if (free.error.kind === "held") pids.push(Number(pid));
    else
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message: `Nimbus could not tell whether the server process ${pid} of an earlier start still runs: its lease ${file} cannot be opened (${free.error.reason}). Check that the config root is writable.`,
        },
      };
  }
  return { ok: true, pids };
}

export const InstallationLock = {
  file: (configRoot: string) => path.join(configRoot, "server.lock"),

  /** Server process `processId`'s lease on the installation, held until it exits. */
  lease(
    configRoot: string,
    processId: string,
  ): { ok: true; value: ExclusiveFile } | { ok: false; error: LeaseError } {
    const file = path.join(
      leases(configRoot),
      `${processId}.${process.pid}.lease`,
    );
    try {
      mkdirSync(leases(configRoot), { recursive: true });
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message: `Nimbus could not create ${leases(configRoot)} (${error instanceof Error ? error.message : String(error)}), so this server did not start. Check that the config root is writable.`,
        },
      };
    }
    const held = ExclusiveFile.acquire(file);
    if (!held.ok)
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message:
            held.error.kind === "held"
              ? `Another process holds this server's lease ${file}, so it did not start. Nothing was changed.`
              : `Nimbus could not take this server's lease ${file} (${held.error.reason}), so it did not start. Check that the config root is writable.`,
        },
      };
    return {
      ok: true,
      value: {
        release() {
          held.value.release();
          removeLease(file);
        },
      },
    };
  },

  /**
   * Wait until no server process of an earlier start holds a lease, as one left draining by a
   * supervisor that died, reporting which ones every `reportMs`. Call it holding the lock.
   */
  async awaitLeases(
    configRoot: string,
    {
      pollMs = 500,
      reportMs = 10_000,
      log = console.warn,
    }: {
      pollMs?: number;
      reportMs?: number;
      log?: (line: string) => void;
    } = {},
  ): Promise<{ ok: true } | { ok: false; error: LeaseError }> {
    let reported = Number.NEGATIVE_INFINITY;
    for (;;) {
      const held = heldLeases(configRoot);
      if (!held.ok || !held.pids.length) return held.ok ? { ok: true } : held;
      if (Date.now() - reported >= reportMs) {
        reported = Date.now();
        log(
          `Nimbus is waiting for server processes ${held.pids.join(", ")} of an earlier start to exit before it starts: they still use this installation (${configRoot}), and two servers on one database would undo each other's changes. They exit once their responses in progress end. If they do not, stop them (kill ${held.pids.join(" ")}).`,
        );
      }
      await Bun.sleep(pollMs);
    }
  },

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
