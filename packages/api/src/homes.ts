import { randomUUID } from "node:crypto";
import { mkdir, readdir, rmdir } from "node:fs/promises";
import { TRPCError } from "@trpc/server";
import type { DriveStore, DriveUser } from "./drive-store";
import { mutateFiles } from "./file-mutations";
import { isFsError, PathError, resolveSafePath } from "./safe-path";

/** Data-root folder that holds every account's home. */
const container = "homes";
const reservedWindowsNames = /^(con|prn|aux|nul|com\d|lpt\d)$/;

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
  return mutateFiles([container], { userId: user.id }, async () => {
    const existing = await store.homeOf(user.id);
    if (existing) return { kind: "existing", path: existing };
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

/** Refuse to move, rename, or delete a home folder or a folder that contains one. */
async function requireNotHome(store: DriveStore, path: string) {
  if (await store.hasHomeWithin(path))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This is a personal home folder, or contains one, so it cannot be renamed, moved, or deleted. A server administrator can remove the account first; its files stay in place.",
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
  container,
  folderName,
  provision,
  requireNotHome,
  backfill,
} as const;
