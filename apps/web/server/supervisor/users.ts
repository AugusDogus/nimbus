import { readFileSync } from "node:fs";

/**
 * Which users the supervisor and the servers run as (see docs/updates.md).
 *
 * `split`: the container entrypoint, started as root, runs the supervisor as a user of its own
 * holding only the capabilities to switch user and signal its servers (setuid, setgid, kill), and names the servers' user
 * (NIMBUS_SERVER_UID and NIMBUS_SERVER_GID, PUID and PGID). The servers then start as that user
 * with no capabilities, so they cannot change the releases the supervisor installs.
 *
 * `single`: everything runs as one user, as when the container is started with `--user`. A
 * server could then rewrite the release it would run next, so in-app updates are off, unless
 * NIMBUS_UPDATES_WITH_ONE_USER=1 asks for them anyway, as development and tests do.
 */
export type Users =
  | {
      kind: "split";
      serverUid: number;
      serverGid: number;
      /** `command` run as the servers' user with no capabilities. */
      server: (command: string[]) => string[];
      /** `command` run as the supervisor's own user with no capabilities. */
      unprivileged: (command: string[]) => string[];
      updatesOff: null;
    }
  | {
      kind: "single";
      server: (command: string[]) => string[];
      unprivileged: (command: string[]) => string[];
      /** Why in-app updates are off, and how to turn them on; null when asked for anyway. */
      updatesOff: string | null;
    };

/** CAP_KILL (5), CAP_SETGID (6) and CAP_SETUID (7) in a CapEff mask: to start and stop servers. */
const SWITCH_USER = 0xe0n;

const id = (value: string | undefined) => {
  const parsed = Number(value);
  return value !== undefined && /^\d+$/.test(value) && parsed > 0
    ? parsed
    : null;
};

export const Users = {
  fromEnvironment(
    env: Record<string, string | undefined>,
    self: { uid: number; status: string },
  ): Users {
    const serverUid = id(env.NIMBUS_SERVER_UID);
    const serverGid = id(env.NIMBUS_SERVER_GID);
    const effective = /^CapEff:\s*([0-9a-f]+)$/m.exec(self.status)?.[1];
    const canSwitch =
      effective !== undefined &&
      (BigInt(`0x${effective}`) & SWITCH_USER) === SWITCH_USER;
    if (
      serverUid !== null &&
      serverGid !== null &&
      serverUid !== self.uid &&
      canSwitch
    )
      return {
        kind: "split",
        serverUid,
        serverGid,
        server: (command) => [
          "setpriv",
          `--reuid=${serverUid}`,
          `--regid=${serverGid}`,
          "--clear-groups",
          "--inh-caps=-all",
          "--ambient-caps=-all",
          "--",
          ...command,
        ],
        unprivileged: (command) => [
          "setpriv",
          "--inh-caps=-all",
          "--ambient-caps=-all",
          "--",
          ...command,
        ],
        updatesOff: null,
      };
    return {
      kind: "single",
      server: (command) => command,
      unprivileged: (command) => command,
      updatesOff:
        env.NIMBUS_UPDATES_WITH_ONE_USER === "1"
          ? null
          : "In-app updates are off: every Nimbus process runs as one user (as when the container is started with --user), so a server could rewrite the release it would run next. To turn them on, start the container as root and give the user with PUID and PGID instead of --user; the entrypoint then runs the supervisor and the servers as users of their own.",
    };
  },

  /** This process's users. */
  current(): Users {
    let status = "";
    try {
      status = readFileSync("/proc/self/status", "utf8");
    } catch {
      status = "";
    }
    return Users.fromEnvironment(process.env, {
      uid: process.getuid?.() ?? -1,
      status,
    });
  },
} as const;
