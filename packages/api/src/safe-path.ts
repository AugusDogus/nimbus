import { lstat } from "node:fs/promises";
import path from "node:path";

import { getDataRoot } from "./data-root";
import type { TRPCError } from "@trpc/server";

export class PathError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "PathError";
  }
}

export type SafePathResult = { absolute: string; relative: string };

/** Why a path through a symbolic link is refused, and the way to reach what it points to. */
export const symbolicLinkRefused =
  "This path goes through a symbolic link on the server. Symbolic links are never followed, so they cannot reach files outside the drive. Nothing was changed. To use what the link points to, ask a server administrator to replace it with the real file or folder, or to mount that folder inside the drive.";

export const isWithinPath = (parent: string, child: string) =>
  parent === "" || parent === child || child.startsWith(`${parent}/`);

export const isFsError = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

/** Paths are already decoded by the HTTP/router boundary. Symlinks are never served. */
export async function resolveSafePath(
  requested: string,
): Promise<SafePathResult> {
  const target = lexicalSafePath(requested);
  let current = getDataRoot();
  for (const segment of target.relative ? target.relative.split("/") : []) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new PathError("FORBIDDEN", symbolicLinkRefused);
      }
    } catch (error) {
      // Nothing exists below a missing folder or a file, so the rest is a missing path.
      if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) break;
      throw error;
    }
  }
  return target;
}

/**
 * The checks of `resolveSafePath` that read nothing from disk. A permission check on its result
 * runs before the path is looked up, so refusing someone says nothing about what is there,
 * not even that a symbolic link is; `resolveSafePath` must still run before the path is used.
 */
export function lexicalSafePath(requested: string): SafePathResult {
  const root = getDataRoot();
  if (
    path.isAbsolute(requested) ||
    requested.includes("\\") ||
    /[\x00-\x1f]/.test(requested)
  ) {
    throw new PathError("BAD_REQUEST", "Use a path inside your drive.");
  }
  const absolute = path.resolve(root, requested);
  const nativeRelative = path.relative(root, absolute);
  if (
    nativeRelative === ".." ||
    nativeRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(nativeRelative)
  ) {
    throw new PathError("BAD_REQUEST", "Use a path inside your drive.");
  }
  const segments = nativeRelative ? nativeRelative.split(path.sep) : [];
  if (segments.some((segment) => segment.toLowerCase() === ".nimbus")) {
    throw new PathError("FORBIDDEN", "Nimbus internal storage is private.");
  }
  return { absolute, relative: segments.join("/") };
}

/**
 * Whether an error carries a tRPC error code: a TRPCError, or a PathError thrown by
 * `resolveSafePath` for callers that do not go through `safePath`.
 */
export function isApiError(error: unknown, code: TRPCError["code"]) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
