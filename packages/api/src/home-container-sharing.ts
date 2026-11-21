import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { DriveStore } from "./drive-store";
import { Homes } from "./homes";
import { DriveRoot } from "./drive-root";

/**
 * Sharing the folder that holds every home folder, or a folder above it.
 *
 * A grant, public link or upload link reaches everything inside its folder, so one on the
 * container or above it (the drive root included) would reach every account's home. That is
 * refused for everyone, administrators included, unless an administrator allows it in
 * Settings; even then each one needs an explicit acknowledgement. Every way Nimbus creates
 * sharing (the browser, MCP tools, through the same procedures) checks `require` here first.
 */

export const sharingKinds = ["grant", "link", "uploadLink"] as const;
export type SharingKind = (typeof sharingKinds)[number];
export const sharingKindSchema = z.enum(sharingKinds);

/** Pass true to share a path that covers every home folder, once that is allowed. */
export const acknowledgementSchema = z
  .boolean()
  .optional()
  .describe(
    "Set to true only after the user confirmed that sharing this folder gives access to every user's home folder. Needed when an administrator allowed sharing the home folders container and the path is that folder or one above it; otherwise leave it out.",
  );

export type HomesExposure =
  | { kind: "none" }
  /** Sharing is refused: the setting is off. */
  | {
      kind: "refused";
      homes: number;
      container: string;
      relation: "is" | "above";
    }
  /** Sharing is allowed but reaches every home folder, so it needs acknowledging. */
  | {
      kind: "warn";
      homes: number;
      container: string;
      relation: "is" | "above";
    };

/** A refused share, typed so callers and tests can tell it from other refusals. */
export class HomesExposureError extends TRPCError {
  constructor(
    readonly exposure: Exclude<HomesExposure, { kind: "none" }>,
    message: string,
  ) {
    super({
      code: exposure.kind === "refused" ? "FORBIDDEN" : "PRECONDITION_FAILED",
      message,
    });
    this.name = "HomesExposureError";
  }
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** What one kind of sharing on the path would let others do with every home folder. */
const reach: Record<SharingKind, (homes: string) => string> = {
  grant: (homes) =>
    `would give the person or group access to every user's home folder (${homes})`,
  link: (homes) =>
    `would let anyone with the link open every user's home folder (${homes})`,
  uploadLink: (homes) =>
    `would let anyone with the link add files to the folder that holds every user's home folder (${homes})`,
};

/**
 * Whether new accounts get no home folder while this kind of sharing covers the container.
 * Provisioning stops for grants and public links, which would open the new home too. An upload
 * link adds single files to its own folder only, beside the homes, so it never reaches one.
 */
const blocksNewHomes: Record<SharingKind, boolean> = {
  grant: true,
  link: true,
  uploadLink: false,
};

const noun: Record<SharingKind, string> = {
  grant: "this access",
  link: "this public link",
  uploadLink: "this upload link",
};

function where(
  path: string,
  exposure: { container: string; relation: "is" | "above" },
) {
  const name = path === "" ? DriveRoot.label : `"${path}"`;
  return exposure.relation === "is"
    ? `${name} is the folder that holds every user's home folder`
    : `${name} contains "${exposure.container}", the folder that holds every user's home folder`;
}

/** The message for a refused or unacknowledged share, shared by every caller. */
function message(
  path: string,
  sharing: SharingKind,
  exposure: Exclude<HomesExposure, { kind: "none" }>,
) {
  const homes = plural(exposure.homes, "home folder", "home folders");
  if (exposure.kind === "refused")
    return `Nimbus did not create ${noun[sharing]}: ${where(path, exposure)}, so it ${reach[sharing](homes)}. Nothing was changed. Share individual folders instead, or a server administrator can turn on "Allow sharing the home folders container" in Settings, Administration.`;
  const homesStop = blocksNewHomes[sharing]
    ? ", and new accounts get no home folder while it exists"
    : "";
  return `${where(path, exposure)}, so ${noun[sharing]} ${reach[sharing](homes)}${homesStop}. Nothing was changed. Share individual folders instead, or confirm with the user and repeat the request with acknowledgeAllHomeFolders set to true.`;
}

/** What sharing `path` would expose, given the administrators' setting. */
async function exposure(
  store: DriveStore,
  path: string,
): Promise<HomesExposure> {
  const exposed = await Homes.exposedBy(store, path);
  const [container] = exposed.containers;
  if (container === undefined) return { kind: "none" };
  const relation = exposed.containers.some(
    (covered) => Homes.spelling(covered) === Homes.spelling(path),
  )
    ? "is"
    : "above";
  return {
    kind: (await store.homeContainerSharingAllowed()) ? "warn" : "refused",
    homes: exposed.homes,
    container,
    relation,
  };
}

/**
 * Changes of the setting, and sharing that covers a container, run one at a time, so a share
 * checked while sharing was allowed is written before the setting can turn off: once turning it
 * off returns, the review list is complete and every later share is refused. Nimbus serves a
 * data root from one process (see README), so a lock in this process covers every writer.
 */
let settingTail: Promise<unknown> = Promise.resolve();
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = settingTail.then(run, run);
  settingTail = result.catch(() => undefined);
  return result;
}

/**
 * Write `sharing` on `path` with `write`, unless it covers a home-folder container and that is
 * not allowed, or allowed but not acknowledged. Call it inside the mutation scope that holds the
 * path, with `write` creating the record; it throws `HomesExposureError` without writing.
 */
async function share<T>(
  store: DriveStore,
  path: string,
  sharing: SharingKind,
  acknowledged: boolean | undefined,
  write: () => Promise<T>,
): Promise<T> {
  // Containers change only at startup, so a path that covers none needs no lock. The setting
  // is read only inside the lock, after any change to it has finished.
  if (!(await Homes.exposedBy(store, path)).containers.length) return write();
  return exclusive(async () => {
    const found = await exposure(store, path);
    if (
      found.kind === "refused" ||
      (found.kind === "warn" && acknowledged !== true)
    )
      throw new HomesExposureError(found, message(path, sharing, found));
    return write();
  });
}

/** Change the setting, after any covering share being written; returns the previous value. */
const setAllowed = (store: DriveStore, allowed: boolean, by: string) =>
  exclusive(() => store.setHomeContainerSharingAllowed(allowed, by));

export const HomeContainerSharing = {
  exposure,
  share,
  setAllowed,
  message,
} as const;
