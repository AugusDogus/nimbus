import { DriveRoot } from "@nimbus/api/drive-root";

/** One breadcrumb: a folder's name and its path relative to the drive root ("" is the root). */
export type Crumb = { label: string; path: string };

/**
 * The breadcrumb for a folder: the root, named by the caller, and the folders below it down to
 * the shown one, which is last. The root is the account's top folder when the shown folder is
 * inside it, otherwise the drive root, so every crumb is a real folder with its real path.
 */
export type BreadcrumbTrail = { root: Crumb; crumbs: Crumb[] };

const within = (top: string, folder: string) =>
  top === "" || folder === top || folder.startsWith(`${top}/`);

export const BreadcrumbTrail = {
  of(folder: string, top: string, rootLabel: string): BreadcrumbTrail {
    const base = within(top, folder) ? top : "";
    const below =
      folder === base ? "" : folder.slice(base ? base.length + 1 : 0);
    const crumbs: Crumb[] = [];
    let path = base;
    for (const label of below ? below.split("/") : []) {
      path = path ? `${path}/${label}` : label;
      crumbs.push({ label, path });
    }
    return { root: { label: rootLabel, path: base }, crumbs };
  },
  /**
   * The crumbs that name `path` for an account whose top folder is `top`, root first, as the
   * breadcrumb shows them: the top (or the drive root) as Files, then each folder below it.
   * `at` is where a crumb's name starts in `path`, so matches found in the path can be marked on
   * it; the root's name is not in the path, so it has none.
   */
  spelled(path: string, top: string): { label: string; at: number | null }[] {
    const trail = BreadcrumbTrail.of(path, top, DriveRoot.label);
    return [
      { label: trail.root.label, at: null },
      ...trail.crumbs.map((crumb) => ({
        label: crumb.label,
        at: crumb.path.length - crumb.label.length,
      })),
    ];
  },
  /** How crumbs are joined when a location is written out: "Files / Projects". */
  separator: " / ",
  /** Where `path` is, written out as the breadcrumb shows it: "Files / Projects / 2025". */
  spell(path: string, top: string): string {
    return BreadcrumbTrail.spelled(path, top)
      .map((part) => part.label)
      .join(BreadcrumbTrail.separator);
  },
  /** A folder's name as the breadcrumb shows it: Files for the top and the drive root. */
  name(folder: string, top: string): string {
    const parts = BreadcrumbTrail.spelled(folder, top);
    return parts[parts.length - 1]?.label ?? DriveRoot.label;
  },
} as const;
