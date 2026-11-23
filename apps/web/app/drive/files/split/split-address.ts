import { useSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import { usePathname } from "@/hooks/use-pathname";
import { FolderPath, useFolderPath } from "../folder-path";
import type { PaneLinks } from "../pane-links";
import { SplitLayout, type PaneSide } from "../split-layout";
import type { SplitSearch } from "../split-search";
import { fileHref } from "../types";

/** A split view as an address holds it: its left folder, in the pathname, and its layout. */
export type CarriedSplit = { left: string; layout: SplitLayout };

/** The params for `layout`. The drive root, an empty path, is spelled `/`. */
function search(layout: SplitLayout): SplitSearch {
  return {
    right: layout.right || "/",
    active: layout.active,
    ratio: String(Math.round(layout.ratio)),
    ...(layout.collapsed ? { collapsed: layout.collapsed } : {}),
  };
}

/** The address of a split view showing `left`, and the layout's right folder beside it. */
function href(left: string, layout: SplitLayout): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search(layout)))
    if (value !== undefined) params.set(key, value);
  return `${fileHref(left)}?${params.toString()}`;
}

/** The split view with `path` shown in `side`, which becomes the active pane. */
const showIn = (
  { left, layout }: CarriedSplit,
  side: PaneSide,
  path: string,
): CarriedSplit =>
  side === "left"
    ? { left: path, layout: { ...layout, active: "left" } }
    : { left, layout: { ...layout, right: path, active: "right" } };

/** The address of the same split view with `path` in its active pane. */
function openInActive(split: CarriedSplit, path: string) {
  const next = showIn(split, split.layout.active, path);
  return href(next.left, next.layout);
}

/** Opens folders in `side` of `split`, which becomes the active pane; the other stays. */
function paneLinks(split: CarriedSplit, side: PaneSide): PaneLinks {
  return {
    to: (path) => {
      const next = showIn(split, side, path);
      return { left: next.left, search: search(next.layout) };
    },
    href: (path) => {
      const next = showIn(split, side, path);
      return href(next.left, next.layout);
    },
  };
}

/**
 * The split view a page shows or carries: a folder page's own, or the one search results keep
 * (`left` and the split params; see `carry`). Null for none.
 */
function carried(
  pathname: string,
  folder: string,
  params: Record<string, unknown>,
): CarriedSplit | null {
  const layout = SplitLayout.parse(params);
  if (!layout) return null;
  if (FolderPath.isShownAt(pathname)) return { left: folder, layout };
  const left =
    pathname === "/search" && typeof params.left === "string"
      ? SplitLayout.folderOf(params.left)
      : null;
  return left === null ? null : { left, layout };
}

/** The split view the window shows or carries now, for code outside React. */
function here(): CarriedSplit | null {
  const { pathname, search: query } = window.location;
  const folder = FolderPath.fromSplat(
    decodeURIComponent(pathname.replace(/^\/browse\/?/, "")),
  );
  return carried(
    pathname,
    folder,
    Object.fromEntries(new URLSearchParams(query)),
  );
}

/** The params search results keep a split view in. */
const carry = (split: CarriedSplit): { left: string } & SplitSearch => ({
  left: split.left || "/",
  ...search(split.layout),
});

/** Writes split views into addresses; `SplitLayout.parse` reads them back. */
export const SplitAddress = {
  search,
  href,
  showIn,
  openInActive,
  paneLinks,
  carried,
  here,
  carry,
} as const;

/** The split view this page shows or carries (see `SplitAddress.carried`). */
export function useCarriedSplit(): CarriedSplit | null {
  const params: Record<string, unknown> = useSearch({ strict: false });
  const pathname = usePathname();
  const folder = useFolderPath();
  return useMemo(
    () => SplitAddress.carried(pathname, folder, params),
    [pathname, folder, params],
  );
}
