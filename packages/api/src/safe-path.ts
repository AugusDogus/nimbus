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

export const isWithinPath = (parent: string, child: string) =>
  parent === "" || parent === child || child.startsWith(`${parent}/`);

export const isFsError = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

/** Paths are already decoded by the HTTP/router boundary. Symlinks are never served. */
export async function resolveSafePath(
  requested: string,
): Promise<SafePathResult> {
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
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new PathError(
          "FORBIDDEN",
          "Symbolic links cannot be accessed through Nimbus.",
        );
      }
    } catch (error) {
      if (isFsError(error, "ENOENT")) break;
      throw error;
    }
  }
  return { absolute, relative: segments.join("/") };
}

/** Error codes survive the separate tRPC copies loaded by Next and the custom server. */
export function isApiError(error: unknown, code: TRPCError["code"]) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
