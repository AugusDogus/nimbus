import type { SplitLayout, SplitSearch } from "../split-layout";
import { fileHref } from "../types";

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

/** Writes a split view into the address; `SplitLayout.parse` reads it back. */
export const SplitAddress = { search, href } as const;
