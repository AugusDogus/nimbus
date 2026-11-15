import { TRPCError } from "@trpc/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getAccess, type Access } from "@nimbus/api/access";
import type { Share } from "@nimbus/api/drive-store";
import { safePath } from "@nimbus/api/file-operations";
import { isApiError, isWithinPath } from "@nimbus/api/safe-path";
import { recordAudit } from "@nimbus/api/audit";
import { ClientIp } from "./client-ip";
import { httpDriveStore } from "./http-files";
import { RateLimiter } from "./rate-limit";
import { SharePolicy } from "./share-policy";

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

function signature(share: Share, expires: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret)
    throw new Error(
      "BETTER_AUTH_SECRET is required for protected share links.",
    );
  return createHmac("sha256", secret)
    .update(`${share.token}:${share.passwordHash}:${expires}`)
    .digest("hex");
}

// Behind a TLS-terminating proxy the request URL is plain HTTP, so use the public origin.
const secureCookies = (process.env.BETTER_AUTH_URL ?? "").startsWith("https:");

export function shareCookie(share: Share) {
  const expires = String(Date.now() + 60 * 60 * 1000);
  return `nimbus-share=${expires}.${signature(share, expires)}; HttpOnly; SameSite=Lax; Path=/api/share/${share.token}; Max-Age=3600${secureCookies ? "; Secure" : ""}`;
}

export function isShareUnlocked(share: Share, request: Request) {
  if (share.passwordHash === null) return true;
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("nimbus-share="))
    ?.slice("nimbus-share=".length);
  const [expires, received] = cookie?.split(".") ?? [];
  if (
    !expires ||
    !received ||
    !/^\d{13}$/.test(expires) ||
    !/^[a-f0-9]{64}$/.test(received) ||
    Number(expires) <= Date.now()
  )
    return false;
  const expected = signature(share, expires);
  return (
    received.length === expected.length &&
    timingSafeEqual(Buffer.from(received), Buffer.from(expected))
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

// Wrong public link passwords, counted per client and per link. Checked before the
// password hash is verified, so throttled guesses cost no hashing.
const failuresByClient = RateLimiter.shared("share-password-client", {
  limit: 10,
  windowMs: 15 * 60 * 1000,
});
const failuresByLink = RateLimiter.shared("share-password-link", {
  limit: 50,
  windowMs: 60 * 60 * 1000,
});

export const SharePasswordAttempts = {
  check(token: string, request: Request) {
    const client = ClientIp.bucket(ClientIp.fromHeaders(request.headers));
    for (const decision of [failuresByClient.check(client), failuresByLink.check(token)])
      if (!decision.allowed) return decision;
    return { allowed: true } as const;
  },
  fail(share: Share, request: Request) {
    failuresByClient.consume(ClientIp.bucket(ClientIp.fromHeaders(request.headers)));
    failuresByLink.consume(share.token);
    recordAudit({
      action: "share.password_failed",
      actor: { type: "anonymous" },
      target: { type: "share", id: share.id, label: share.path },
    });
  },
} as const;
