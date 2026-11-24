import type { Ids } from "./credentials";

/**
 * Which users the supervisor, its servers and its installer run as (see docs/updates.md),
 * decided once, here, from canonical numeric ids:
 *
 * - `split`: started as root, as the image's entrypoint starts it. The supervisor stays root
 *   with a fixed, small job (verify releases, start children with dropped privileges, pass
 *   signals); servers run as `server` (PUID:PGID) and the installer as `update`, each through
 *   `setpriv` with no capabilities, no supplementary groups, an empty bounding set and
 *   `no_new_privs`. `update` is null, and updates off, when the update user's ids are not ones
 *   of their own.
 * - `single`: started as another user, as with `docker run --user`: everything runs as that one
 *   user, so a server could rewrite the release it would run next, and updates are off unless a
 *   test in a source checkout asks for them (TestSeams).
 * - `refused`: started as root without the servers' ids: it would run servers as root, so the
 *   supervisor does not start.
 */
export type Users =
  | {
      kind: "split";
      server: Ids;
      update: Ids | null;
      updatesOff: string | null;
    }
  | { kind: "single"; updatesOff: string | null }
  | { kind: "refused"; message: string };

/** An id given as canonical decimal digits, from 1 to 4294967294; null otherwise. */
function id(value: string | undefined) {
  if (value === undefined || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= 4_294_967_294 ? parsed : null;
}

const DEFAULT_UPDATE_ID = "1100";

export const Users = {
  fromEnvironment(
    env: Record<string, string | undefined>,
    self: { euid: number; oneUserUpdates: boolean },
  ): Users {
    if (self.euid !== 0)
      return {
        kind: "single",
        updatesOff: self.oneUserUpdates
          ? null
          : "In-app updates are off: every Nimbus process runs as one user (as when the container is started with --user), so a server could rewrite the release it would run next. To turn them on, start the container as root and give the user with PUID and PGID instead of --user.",
      };
    const uid = id(env.NIMBUS_SERVER_UID);
    const gid = id(env.NIMBUS_SERVER_GID);
    if (uid === null || gid === null)
      return {
        kind: "refused",
        message:
          "Nimbus did not start: its supervisor runs as root but was not told which user to run servers as (NIMBUS_SERVER_UID and NIMBUS_SERVER_GID, numbers from 1 to 4294967294), and it never runs servers as root. Start it through the image's entrypoint, which sets them from PUID and PGID.",
      };
    const server = { uid, gid };
    const updateUid = id(env.NIMBUS_UPDATE_UID ?? DEFAULT_UPDATE_ID);
    const updateGid = id(env.NIMBUS_UPDATE_GID ?? DEFAULT_UPDATE_ID);
    if (
      updateUid === null ||
      updateGid === null ||
      updateUid === uid ||
      updateGid === gid ||
      updateUid === gid ||
      updateGid === uid
    )
      return {
        kind: "split",
        server,
        update: null,
        updatesOff: `In-app updates are off: the update user (NIMBUS_UPDATE_UID and NIMBUS_UPDATE_GID, default ${DEFAULT_UPDATE_ID}) must be ids of its own, other than PUID and PGID. Servers still run as ${uid}:${gid}. Unset them, or set other numbers.`,
      };
    return {
      kind: "split",
      server,
      update: { uid: updateUid, gid: updateGid },
      updatesOff: null,
    };
  },

  /** `command` run as `ids` with nothing more: no capability, group or way to gain either. */
  dropTo(ids: Ids, command: string[]): string[] {
    return [
      "setpriv",
      `--reuid=${ids.uid}`,
      `--regid=${ids.gid}`,
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--bounding-set=-all",
      "--no-new-privs",
      "--",
      ...command,
    ];
  },
} as const;
