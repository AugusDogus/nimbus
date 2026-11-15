import { TRPCError } from "@trpc/server";
import { getAccess, type Access } from "@nimbus/api/access";
import { FileRequest } from "@nimbus/api/file-request";
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
 * A file request works only while it is unexpired and its creator is active
 * and still manages sharing for the folder, mirroring public download links.
 */
export async function activeFileRequest(
  lookup: { token: string } | { id: string },
): Promise<{ request: FileRequest; owner: Access }> {
  const request =
    "token" in lookup
      ? await httpDriveStore.fileRequests.getByToken(lookup.token)
      : await httpDriveStore.fileRequests.getById(lookup.id);
  if (!request || FileRequest.availability(request, Date.now()).kind !== "available")
    throw unavailable();
  let owner: Access;
  try {
    owner = await getAccess(httpDriveStore, request.createdBy);
  } catch (error) {
    if (isApiError(error, "UNAUTHORIZED")) throw unavailable();
    throw error;
  }
  if (!owner.can(request.path, "admin")) throw unavailable();
  return { request, owner };
}

const unlockScope = (request: FileRequest & { passwordHash: string }) => ({
  name: `nimbus-request-${request.id}`,
  // Sent to the request's details endpoint and to the upload endpoint.
  path: "/api/file-request",
  token: request.token,
  passwordHash: request.passwordHash,
});

export function fileRequestCookie(
  request: FileRequest & { passwordHash: string },
) {
  return UnlockCookie.issue(unlockScope(request));
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
  check(token: string, incoming: Request) {
    return fileRequestPasswords.check(token, incoming);
  },
  fail(request: FileRequest, incoming: Request) {
    fileRequestPasswords.fail(request.token, incoming);
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

/** Abuse limits for anonymous callers, keyed by link and by client address. */
export const FileRequestLimits = {
  uploadsPerClient: RateLimiter.shared("file-request-uploads-client", { limit: 120, windowMs: 60 * 60 * 1000 }),
  uploadsPerLink: RateLimiter.shared("file-request-uploads-link", { limit: 1000, windowMs: 60 * 60 * 1000 }),
  /** Unfinished uploads one link may hold at once. */
  maxActiveUploads: 20,
  /** Free space each upload must leave on the data filesystem. */
  minimumFreeBytes: 1024 ** 3,
} as const;
