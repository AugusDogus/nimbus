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
} as const;
