import { randomUUID } from "node:crypto";
import { mkdir, readdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import type { DriveStore, DriveUser, SharedPaths } from "./drive-store";
import { fileNameSchema } from "./file-name";
import { mutateFiles } from "./file-mutations";
import { VacantPath } from "./vacant-path";
import {
  isFsError,
  isWithinPath,
  PathError,
  resolveSafePath,
} from "./safe-path";

/** Data-root folder that holds every account's home unless NIMBUS_HOMES_PATH names another. */
const defaultContainer = "users";
const reservedWindowsNames = /^(con|prn|aux|nul|com\d|lpt\d)$/;

/**
 * The folder, relative to the data root, that holds every account's home: NIMBUS_HOMES_PATH,
 * or `users`. Throws when the value is not a plain relative folder path, so startup fails.
 */
function containerPath(value = process.env.NIMBUS_HOMES_PATH) {
  if (value === undefined || value === "") return defaultContainer;
  const valid = value
    .split("/")
    .every(
      (segment) =>
        segment === segment.trim() && fileNameSchema.safeParse(segment).success,
    );
  if (!valid)
    throw new Error(
      `NIMBUS_HOMES_PATH must be a folder path relative to the data root, such as users or team/users: no leading or trailing slash or spaces, no "." or ".." segments, backslashes or control characters, and not the reserved .nimbus folder. It is "${value}". Nothing was changed; fix the value and restart.`,
    );
  return value;
}

export type HomeContainer =
  | { kind: "ready"; path: string; created: boolean }
  | { kind: "refused"; message: string };

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * Path comparisons for home folders ignore case: a volume shared over SMB or on a
 * case-insensitive filesystem treats `Users` and `users` as one folder.
 */
const covers = (parent: string, child: string) =>
  isWithinPath(parent.toLowerCase(), child.toLowerCase());

/**
 * Sharing that would reach a home created inside `container`: grants and public links on it or
 * on a folder above it, including the drive root.
 */
function sharingOver(container: string, shared: SharedPaths) {
  const over = (paths: string[]) =>
    paths.filter((recorded) => covers(recorded, container)).length;
  return [
    plural(over(shared.grants), "sharing grant", "sharing grants") +
      " on it or on a folder above it",
    plural(over(shared.links), "public link", "public links") +
      " on it or on a folder above it",
  ].filter((found) => !found.startsWith("0 "));
}

/** Everything recorded at or inside `container`, which a folder new to Nimbus must not have. */
function recordsWithin(container: string, shared: SharedPaths) {
  const within = (paths: string[]) =>
    paths.filter(
      (recorded) =>
        covers(container, recorded) &&
        recorded.toLowerCase() !== container.toLowerCase(),
    ).length;
  const at = (paths: string[]) =>
    paths.filter((recorded) => covers(container, recorded)).length;
  return [
    plural(within(shared.grants), "sharing grant", "sharing grants") +
      " inside it",
    plural(within(shared.links), "public link", "public links") + " inside it",
    plural(at(shared.fileRequests), "upload link", "upload links") +
      " on it or inside it",
    plural(at(shared.bookmarks), "bookmark", "bookmarks") +
      " on it or inside it",
  ].filter((found) => !found.startsWith("0 "));
}

/** The existing entry at `absolute`, matching its name case-insensitively, and what it holds. */
async function existingEntry(absolute: string) {
  let siblings: string[];
  try {
    siblings = await readdir(path.dirname(absolute));
  } catch (error) {
    if (isFsError(error, "ENOENT")) return null;
    throw error;
  }
  const name = path.basename(absolute).toLowerCase();
  const match = siblings.find((sibling) => sibling.toLowerCase() === name);
  if (match === undefined) return null;
  const held = await readdir(path.join(path.dirname(absolute), match)).then(
    (entries) => plural(entries.length, "item", "items"),
    () => "not a readable folder",
  );
  return `the data root already has "${match}" (${held}), which Nimbus did not create`;
}

/**
 * Make sure the configured container exists and is Nimbus's own before any home goes into it.
 * A folder Nimbus recorded creating is reused, and recreated if it went missing. Otherwise it
 * is created and recorded, unless something already exists there or sharing records already
 * cover that path: home folders placed there would be exposed to whoever has that access.
 */
async function prepare(
  store: DriveStore,
  container = containerPath(),
): Promise<HomeContainer> {
  const refuse = (found: string[]): HomeContainer => ({
    kind: "refused",
    message: `Nimbus did not start because it cannot use "${container}" for home folders: ${found.join("; ")}. Home folders placed there could be seen by whoever already has access. No folders or sharing were changed. Set NIMBUS_HOMES_PATH to a folder that does not exist yet and is not inside a shared folder, or rename the existing "${container}" folder and remove its sharing, then restart.`,
  });
  let target: Awaited<ReturnType<typeof resolveSafePath>>;
  try {
    target = await resolveSafePath(container);
  } catch (error) {
    if (error instanceof PathError) return refuse([error.message]);
    throw error;
  }
  if ((await store.listHomeContainers()).includes(container)) {
    // Recreated if it went missing: records left there would reach the homes put into it.
    await VacantPath.claim(store, target);
    await mkdir(target.absolute, { recursive: true });
    return { kind: "ready", path: container, created: false };
  }
  const shared = await store.sharedPaths();
  const found = [
    ...sharingOver(container, shared),
    ...recordsWithin(container, shared),
  ];
  const existing = await existingEntry(target.absolute);
  if (existing) found.unshift(existing);
  if (found.length) return refuse(found);
  // Created exclusively before it is recorded, so a recorded folder is always one Nimbus
  // made. A crash in between leaves an empty folder that the next start refuses to adopt.
  await mkdir(path.dirname(target.absolute), { recursive: true });
  try {
    await mkdir(target.absolute);
  } catch (error) {
    if (isFsError(error, "EEXIST"))
      return refuse([
        `"${container}" was created by something else while Nimbus was starting`,
      ]);
    throw error;
  }
  try {
    await store.addHomeContainer(container);
  } catch (error) {
    await rmdir(target.absolute).catch(() => undefined);
    throw error;
  }
  return { kind: "ready", path: container, created: true };
}

export type HomeProvisioning =
  | { kind: "created"; path: string }
  | { kind: "existing"; path: string }
  | { kind: "failed"; message: string };

/**
 * Folder name for a new home: the email's local part, lowercased and limited to portable
 * characters. It is fixed when the home is created; later email changes do not rename it.
 */
function folderName(email: string) {
  const local = email.slice(
    0,
    Math.max(0, email.lastIndexOf("@")) || email.length,
  );
  const name = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64);
  if (!name) return "user";
  return reservedWindowsNames.test(name) ? `${name}-home` : name;
}

/**
 * Create an account's home folder with an Admin grant, unless it already has one. An
 * existing folder is never adopted, because it may belong to someone else: the name gets
 * a numeric suffix instead. Names are compared case-insensitively for portable shares.
 */
async function provision(
  store: DriveStore,
  user: Pick<DriveUser, "id" | "email">,
): Promise<HomeProvisioning> {
  try {
    return await provisionUnlocked(store, user);
  } catch (error) {
    return {
      kind: "failed",
      message: `Creating a home folder for ${user.email} failed: ${error instanceof Error ? error.message : String(error)}. The account works without a home; Nimbus retries at its next start.`,
    };
  }
}

function provisionUnlocked(
  store: DriveStore,
  user: Pick<DriveUser, "id" | "email">,
): Promise<HomeProvisioning> {
  const container = containerPath();
  return mutateFiles([container], { userId: user.id }, async () => {
    const existing = await store.homeOf(user.id);
    if (existing) return { kind: "existing", path: existing };
    if (!(await store.listHomeContainers()).includes(container))
      return {
        kind: "failed",
        message: `Nimbus has not set up "${container}" for home folders, so ${user.email} got none. The account works without a home; restart Nimbus, which prepares the folder or says why it cannot.`,
      };
    const sharing = sharingOver(container, await store.sharedPaths());
    if (sharing.length)
      return {
        kind: "failed",
        message: `Nimbus did not create a home folder for ${user.email} because "${container}" has ${sharing.join(" and ")}, which would give others access to it. The account works without a home. Remove that sharing, or set NIMBUS_HOMES_PATH to a new folder, then restart Nimbus to retry.`,
      };
    let created: string | null = null;
    try {
      const parent = await resolveSafePath(container);
      await mkdir(parent.absolute, { recursive: true });
      const taken = new Set(
        (await readdir(parent.absolute)).map((name) => name.toLowerCase()),
      );
      const base = folderName(user.email);
      for (let attempt = 1; attempt <= 1000 && !created; attempt++) {
        const name = attempt === 1 ? base : `${base}-${attempt}`;
        if (taken.has(name)) continue;
        const target = await resolveSafePath(`${container}/${name}`);
        // Records left by content removed outside Nimbus never attach to the new home.
        if ((await VacantPath.claim(store, target)).kind === "occupied")
          continue;
        try {
          await mkdir(target.absolute);
          created = target.relative;
        } catch (error) {
          if (!isFsError(error, "EEXIST")) throw error;
        }
      }
      if (!created)
        return {
          kind: "failed",
          message: `No free folder name was found under ${container}/ for ${user.email}. The account works without a home; rename some folders in ${container}/ and restart Nimbus to retry.`,
        };
      await store.createHome(
        { userId: user.id, path: created },
        {
          id: randomUUID(),
          path: created,
          subject: { type: "user", id: user.id },
          permission: "admin",
        },
      );
      return { kind: "created", path: created };
    } catch (error) {
      // The new folder is still empty, so removing it leaves the drive as it was.
      if (created)
        await rmdir((await resolveSafePath(created)).absolute).catch(
          () => undefined,
        );
      const reason =
        error instanceof PathError || error instanceof Error
          ? error.message
          : String(error);
      return {
        kind: "failed",
        message: `Creating a home folder for ${user.email} failed: ${reason}. The account works without a home; Nimbus retries at its next start.`,
      };
    }
  });
}

/**
 * Whether a path is a home folder, a folder Nimbus created to hold homes, or a folder that
 * contains either: what can never be moved, renamed or deleted. Read once, then asked per path,
 * so a listing checks every entry with two queries.
 */
async function protection(store: DriveStore) {
  const protectedPaths = [
    ...(await store.listHomes()).map((home) => home.path),
    ...(await store.listHomeContainers()),
  ];
  // A path covers a protected one when it is that path or a folder above it (`covers`), so the
  // covering paths are each protected path and its ancestors, the drive root included. A set of
  // them answers each path at once: listings ask for every entry, and there is a home per account.
  const covering = new Set<string>();
  for (const protectedPath of protectedPaths) {
    const lower = protectedPath.toLowerCase();
    covering.add("");
    for (
      let slash = lower.indexOf("/");
      slash !== -1;
      slash = lower.indexOf("/", slash + 1)
    )
      covering.add(lower.slice(0, slash));
    covering.add(lower);
  }
  return (path: string) => covering.has(path.toLowerCase());
}

/** Refuse to move, rename, or delete what `protection` covers. */
async function requireNotHome(store: DriveStore, path: string) {
  if ((await protection(store))(path))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This is a personal home folder or the folder that holds them, or contains one, so it cannot be renamed, moved, or deleted. Its contents can be changed. A server administrator can remove an account first; its files stay in place.",
    });
}

/** Give every account without a home its own, for installations created before homes existed. */
async function backfill(store: DriveStore) {
  const withHome = new Set(
    (await store.listHomes()).map((home) => home.userId),
  );
  const results: HomeProvisioning[] = [];
  for (const user of await store.listUsers())
    if (!withHome.has(user.id)) results.push(await provision(store, user));
  return results;
}

export const Homes = {
  containerPath,
  prepare,
  folderName,
  provision,
  protection,
  requireNotHome,
  backfill,
} as const;
