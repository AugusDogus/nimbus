import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { symbolicLinkRefused } from "./safe-path";

/**
 * Expected filesystem failures as typed API errors.
 *
 * Node reports a failed system call with its code and a message naming the absolute host path,
 * such as `EACCES: permission denied, mkdir '/data/Projects/New'`. Passed on, that message
 * shows clients where the drive lives on the host, and its code tells apart paths that exist
 * from paths that do not. So every boundary that answers clients (tRPC, MCP tools, the HTTP
 * routes and WebDAV) maps these failures here to a code and a plain message that says what
 * happened, what is preserved and what to do. The original error, with its path, goes only to
 * the server log, through the boundary's own error logging or `cause`.
 */

const systemError = z.object({ code: z.string(), syscall: z.string() });

type Failure = { code: TRPCError["code"]; message: string };

const failures: Record<string, Failure> = {
  ENOENT: {
    code: "NOT_FOUND",
    message:
      "This file or folder no longer exists, or its folder was removed. Nothing was changed. Refresh the drive.",
  },
  ENOTDIR: {
    code: "NOT_FOUND",
    message:
      "This path runs through a file, so nothing exists there. Nothing was changed. Refresh the drive.",
  },
  EEXIST: {
    code: "CONFLICT",
    message:
      "An item with that name already exists. Nothing was changed. Choose another name.",
  },
  ENOTEMPTY: {
    code: "CONFLICT",
    message:
      "The folder is not empty, so it was not replaced. Nothing was changed. Refresh the drive and try again.",
  },
  EISDIR: {
    code: "BAD_REQUEST",
    message:
      "This is a folder, and the operation needs a file. Nothing was changed. Choose a file.",
  },
  ENAMETOOLONG: {
    code: "BAD_REQUEST",
    message:
      "This name or path is too long for the server's disk, which allows 255 bytes per name; letters outside English can take several bytes each. Nothing was changed. Choose a shorter name.",
  },
  ELOOP: {
    code: "FORBIDDEN",
    message: symbolicLinkRefused,
  },
  EACCES: {
    code: "FORBIDDEN",
    message:
      "The server's own permissions on its disk do not allow this, even though your Nimbus permissions do. Nothing was changed. Ask a server administrator to give the Nimbus service account access to this item and its folder.",
  },
  EPERM: {
    code: "FORBIDDEN",
    message:
      "The server's own permissions on its disk do not allow this, even though your Nimbus permissions do. Nothing was changed. Ask a server administrator to give the Nimbus service account access to this item and its folder.",
  },
  EROFS: {
    code: "FORBIDDEN",
    message:
      "This folder is on storage the server mounted read-only. Nothing was changed. Ask a server administrator to make it writable.",
  },
  ENOSPC: {
    code: "SERVICE_UNAVAILABLE",
    message:
      "The server's disk is full. Nothing was changed. Free some space, or ask a server administrator to add storage, then try again.",
  },
  EDQUOT: {
    code: "SERVICE_UNAVAILABLE",
    message:
      "The server's disk quota is used up. Nothing was changed. Free some space, or ask a server administrator to raise the quota, then try again.",
  },
  EBUSY: {
    code: "CONFLICT",
    message:
      "Another program on the server is using this item. Nothing was changed. Try again in a moment.",
  },
};

/**
 * The API error for an expected filesystem failure, keeping the original as its cause for the
 * server log; null for anything else, which stays an internal error.
 */
function toApiError(error: unknown): TRPCError | null {
  const parsed = systemError.safeParse(error);
  if (!parsed.success) return null;
  const failure = failures[parsed.data.code];
  return failure
    ? new TRPCError({
        code: failure.code,
        message: failure.message,
        cause: error,
      })
    : null;
}

export const FilesystemFailure = { toApiError } as const;
