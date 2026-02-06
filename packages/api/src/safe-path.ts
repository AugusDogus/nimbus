import path from "node:path";

import { getDataRoot } from "./data-root";

export type SafePathResult = {
  /** Absolute path on disk */
  absolute: string;
  /** Path relative to data root (forward slashes) */
  relative: string;
};

/**
 * Resolves a user-supplied path against the data root, enforcing:
 *  - no traversal beyond root (.. or absolute escape)
 *  - no access to .nimbus internal directory
 *
 * Returns both absolute and relative (normalized, forward-slash) paths.
 * Throws a plain object `{ code, message }` on violation so callers can
 * map to their own error format (TRPCError, HTTP response, etc.).
 */
export function resolveSafePath(requested: string): SafePathResult {
  const root = getDataRoot();
  const decoded = safeDecode(requested);
  const resolved = path.resolve(root, decoded);
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw { code: "BAD_REQUEST", message: "Invalid path." };
  }

  if (relative.split(path.sep).includes(".nimbus")) {
    throw { code: "FORBIDDEN", message: "Access denied." };
  }

  return {
    absolute: resolved,
    relative: relative.split(path.sep).join("/"),
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
