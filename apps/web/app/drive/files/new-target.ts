/** A folder and whether the account may add to it, `undefined` until the server answers. */
type Candidate = { path: string; canWrite: boolean | undefined };

/**
 * Where New creates and uploads: the folder shown, or, from any other files
 * page (Shared, Recent, Starred, Trash, search, or a folder that is missing or refused), the
 * account's Files home. New is on every files page, so the sidebar keeps its shape; where it has
 * nowhere to create, it stays, disabled, and says why.
 */
export type NewTarget =
  | { kind: "folder"; path: string }
  | { kind: "home"; path: string }
  | { kind: "none"; reason: string }
  | { kind: "pending" };

const reasons = {
  viewOnlyFolder: "You can view this folder, but not add to it.",
  viewOnlyAccount:
    "Your account can view files, but has no folder to add them to. Ask an administrator for one.",
} as const;

export const NewTarget = {
  reasons,

  /**
   * On a folder page, that folder. Elsewhere, the folder Files opens (`top`), or, when that is
   * the drive root and the account may not add there, its home folder.
   */
  resolve(
    page:
      | ({ page: "folder" } & Candidate)
      | { page: "other"; top: Candidate; home: Candidate | null },
  ): NewTarget {
    if (page.page === "folder") {
      if (page.canWrite === undefined) return { kind: "pending" };
      return page.canWrite
        ? { kind: "folder", path: page.path }
        : { kind: "none", reason: reasons.viewOnlyFolder };
    }
    for (const candidate of [page.top, page.home]) {
      if (candidate === null) continue;
      if (candidate.canWrite === undefined) return { kind: "pending" };
      if (candidate.canWrite) return { kind: "home", path: candidate.path };
    }
    return { kind: "none", reason: reasons.viewOnlyAccount };
  },

  /** The folder to create in, or null when there is none yet. */
  path: (target: NewTarget) =>
    target.kind === "folder" || target.kind === "home" ? target.path : null,
} as const;
