import { TRPCError } from "@trpc/server";
import { getAccess, type Access } from "@nimbus/api/access";
import type { Share } from "@nimbus/api/drive-store";
import { isApiError } from "@nimbus/api/safe-path";
import { recordAudit } from "@nimbus/api/audit";
import { httpDriveStore } from "./http-files";
import { LinkPasswordAttempts } from "./link-password-attempts";
import { SharePolicy } from "./share-policy";
import { UnlockCookie } from "./unlock-cookie";

export { sharedTarget } from "./shared-target";

/**
 * The share behind `token` and its creator's access, or NOT_FOUND. `exhausted: "allow"` returns
 * a share that has used its downloads, for a byte request that may continue a counted transfer;
 * the caller must then refuse anything that is not such a continuation.
 */
export async function getPublicShare(
  token: string,
  { exhausted }: { exhausted: "allow" | "refuse" } = { exhausted: "refuse" },
) {
  const share = await httpDriveStore.getShare(token);
  const availability = share
    ? SharePolicy.availability(share, Date.now())
    : { kind: "expired" as const };
  if (
    !share ||
    availability.kind === "expired" ||
    (availability.kind === "exhausted" && exhausted === "refuse")
  )
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

const unlockScope = (
  share: Share & { passwordHash: string },
  path = `/api/share/${share.token}`,
) => ({
  name: "nimbus-share",
  path,
  token: share.token,
  binding: share.passwordHash,
});

/**
 * The unlock cookies for a link: one for its endpoint and one for its page, which the server
 * renders with the same check, so a reload within the hour shows the files, not the form.
 */
export function shareCookies(share: Share & { passwordHash: string }) {
  return [
    UnlockCookie.issue(unlockScope(share)),
    UnlockCookie.issue(unlockScope(share, `/s/${share.token}`)),
  ];
}

export function isShareUnlocked(share: Share, request: Request) {
  const { passwordHash } = share;
  return (
    passwordHash === null ||
    UnlockCookie.verify(unlockScope({ ...share, passwordHash }), request)
  );
}

const sharePasswords = LinkPasswordAttempts.create("share");

export const SharePasswordAttempts = {
  begin(token: string, request: Request) {
    return sharePasswords.begin(token, request);
  },
  /** Audit a wrong password; the attempt was counted when it began. */
  failed(share: Share) {
    recordAudit({
      action: "share.password_failed",
      actor: { type: "anonymous" },
      target: { type: "share", id: share.id, label: share.path },
    });
  },
} as const;
