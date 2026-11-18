import { createHash, randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { getAccess, type Access } from "@nimbus/api/access";
import { FileRequest } from "@nimbus/api/file-request";
import { FilesystemCapacity } from "@nimbus/api/filesystem-capacity";
import { requireExisting } from "@nimbus/api/file-operations";
import { isApiError } from "@nimbus/api/safe-path";
import { httpDriveStore } from "./http-files";
import { recordAudit } from "@nimbus/api/audit";
import { ClientIp } from "./client-ip";
import { LinkPasswordAttempts } from "./link-password-attempts";
import { RateLimiter } from "./rate-limit";
import { UnlockCookie } from "./unlock-cookie";

const unavailable = () =>
  new TRPCError({
    code: "NOT_FOUND",
    message:
      "This upload link has expired or been revoked. Ask the person who sent it for a new link.",
  });

/**
 * A file request works only while it is unexpired, its folder exists, and its
 * creator is active and still manages sharing for the folder, mirroring public
 * download links.
 */
export async function activeFileRequest(
  lookup: { token: string } | { id: string },
): Promise<{ request: FileRequest; owner: Access }> {
  const request =
    "token" in lookup
      ? await httpDriveStore.fileRequests.getByToken(lookup.token)
      : await httpDriveStore.fileRequests.getById(lookup.id);
  if (
    !request ||
    FileRequest.availability(request, Date.now()).kind !== "available"
  )
    throw unavailable();
  let owner: Access;
  try {
    owner = await getAccess(httpDriveStore, request.createdBy);
  } catch (error) {
    if (isApiError(error, "UNAUTHORIZED")) throw unavailable();
    throw error;
  }
  if (!owner.can(request.path, "admin")) throw unavailable();
  // A trashed or moved folder stops the link before anyone uploads into nothing.
  let folder;
  try {
    folder = await requireExisting(request.path);
  } catch (error) {
    if (isApiError(error, "NOT_FOUND")) throw unavailable();
    throw error;
  }
  if (!folder.stats.isDirectory()) throw unavailable();
  return { request, owner };
}

const unlockScope = (
  request: FileRequest & { passwordHash: string },
  // Sent to the request's details endpoint and to the upload endpoint.
  path = "/api/file-request",
) => ({
  name: `nimbus-request-${request.id}`,
  path,
  token: request.token,
  binding: request.passwordHash,
});

/**
 * The unlock cookies for an upload link: one for its endpoints and one for its page, which the
 * server renders with the same check, so a reload within the hour shows the upload form.
 */
export function fileRequestCookies(
  request: FileRequest & { passwordHash: string },
) {
  return [
    UnlockCookie.issue(unlockScope(request)),
    UnlockCookie.issue(unlockScope(request, `/r/${request.token}`)),
  ];
}

export function isFileRequestUnlocked(request: FileRequest, incoming: Request) {
  const { passwordHash } = request;
  return (
    passwordHash === null ||
    UnlockCookie.verify(unlockScope({ ...request, passwordHash }), incoming)
  );
}

const fileRequestPasswords = LinkPasswordAttempts.create("file-request");

export const FileRequestPasswordAttempts = {
  begin(token: string, incoming: Request) {
    return fileRequestPasswords.begin(token, incoming);
  },
  /** Audit a wrong password; the attempt was counted when it began. */
  failed(request: FileRequest) {
    recordAudit({
      action: "file_request.password_failed",
      actor: { type: "anonymous" },
      target: { type: "file_request", id: request.id, label: request.path },
    });
  },
} as const;

/** The anonymous uploader's client address, as derived once per request by the server. */
export const uploaderAddress = (incoming: Request) =>
  ClientIp.bucket(ClientIp.fromHeaders(incoming.headers));

const uploaderCookieName = "nimbus-uploader";

/**
 * A random, HttpOnly identity for this browser. Each upload is bound to it, so
 * other people holding the same link cannot resume, probe or cancel it.
 */
export const Uploader = {
  hash(request: Request) {
    const value = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${uploaderCookieName}=`))
      ?.slice(uploaderCookieName.length + 1);
    return value && /^[\w-]{43}$/.test(value)
      ? createHash("sha256").update(value).digest("hex")
      : null;
  },
  /**
   * Set-Cookie values for a browser without an identity, or none if it has one. The identity
   * goes to the upload endpoints and to upload pages, which the server renders by asking the
   * same endpoint, so a page load never replaces it.
   */
  issue(request: Request): string[] {
    if (Uploader.hash(request)) return [];
    const value = randomBytes(32).toString("base64url");
    return ["/api/file-request", "/r"].map(
      (path) =>
        `${uploaderCookieName}=${value}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=${7 * 24 * 60 * 60}${UnlockCookie.secureAttribute}`,
    );
  },
} as const;

const minute = 60 * 1000;

/**
 * Abuse limits for anonymous uploaders, on top of the password limits above. The
 * client address is derived once per request from the socket and trusted proxies.
 */
export const FileRequestLimits = {
  uploadsPerClientAndLink: RateLimiter.shared(
    "file-request-uploads-client-link",
    { limit: 20, windowMs: minute },
  ),
  uploadsPerClient: RateLimiter.shared("file-request-uploads-client", {
    limit: 60,
    windowMs: minute,
  }),
  uploadsPerLink: RateLimiter.shared("file-request-uploads-link", {
    limit: 1000,
    windowMs: 60 * minute,
  }),
  /** Unfinished uploads one link may hold at once. */
  maxActiveUploads: 20,
  /** Free space each upload must leave. */
  minimumFreeBytes: FilesystemCapacity.minimumFreeBytes,
} as const;
