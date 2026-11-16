import { TRPCError } from "@trpc/server";
import { getAccess, type Access } from "@nimbus/api/access";
import type { Share } from "@nimbus/api/drive-store";
import { safePath } from "@nimbus/api/file-operations";
import { isApiError, isWithinPath } from "@nimbus/api/safe-path";
import { recordAudit } from "@nimbus/api/audit";
import { httpDriveStore } from "./http-files";
import { LinkPasswordAttempts } from "./link-password-attempts";
import { SharePolicy } from "./share-policy";
import { UnlockCookie } from "./unlock-cookie";

export async function getPublicShare(token: string) {
  const share = await httpDriveStore.getShare(token);
  const availability = share
    ? SharePolicy.availability(share, Date.now())
    : { kind: "expired" as const };
  if (!share || availability.kind !== "available")
    throw new TRPCError({
      code: "NOT_FOUND",
      message:
        availability.kind === "exhausted"
          ? "This share link has reached its download limit. Ask the owner for a new link."
          : "This share link has expired or been revoked. Ask the owner for a new link.",
    });
  let access: Access;
  try {
    access = await getAccess(httpDriveStore, share.createdBy);
  } catch (error) {
    if (isApiError(error, "UNAUTHORIZED"))
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "This share link is no longer available.",
      });
    throw error;
  }
  if (!access.can(share.path, "admin"))
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "This share link is no longer available.",
    });
  return { share, access };
}

const unlockScope = (share: Share & { passwordHash: string }) => ({
  name: "nimbus-share",
  path: `/api/share/${share.token}`,
  token: share.token,
  passwordHash: share.passwordHash,
});

export function shareCookie(share: Share & { passwordHash: string }) {
  return UnlockCookie.issue(unlockScope(share));
}

export function isShareUnlocked(share: Share, request: Request) {
  const { passwordHash } = share;
  return (
    passwordHash === null ||
    UnlockCookie.verify(unlockScope({ ...share, passwordHash }), request)
  );
}

export async function sharedTarget(
  share: Share,
  access: Access,
  child: string,
) {
  const target = await safePath([share.path, child].filter(Boolean).join("/"));
  if (!isWithinPath(share.path, target.relative))
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This path is outside the shared folder.",
    });
  const scoped: Access = {
    ...access,
    can: (requested, permission) =>
      permission === "read" &&
      isWithinPath(share.path, requested) &&
      access.can(requested, "read"),
    canBrowse: (requested) =>
      isWithinPath(share.path, requested) && access.can(requested, "read"),
    require(requested, permission) {
      if (!this.can(requested, permission))
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This link does not grant access to that item.",
        });
    },
  };
  return { target, access: scoped };
}

const sharePasswords = LinkPasswordAttempts.create("share");

export const SharePasswordAttempts = {
  check(token: string, request: Request) {
    return sharePasswords.check(token, request);
  },
  fail(share: Share, request: Request) {
    sharePasswords.fail(share.token, request);
    recordAudit({
      action: "share.password_failed",
      actor: { type: "anonymous" },
      target: { type: "share", id: share.id, label: share.path },
    });
  },
} as const;
