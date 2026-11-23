import { createContext, useContext } from "react";
import { fileHref } from "./types";
import type { SplitSearch } from "./split-layout";

/**
 * Where a folder opens from the pane around a link: the address's left folder and its split
 * params, so the other pane stays as it is. Outside a split view there is none, and folders
 * open as the page's one folder.
 */
export type PaneLinks = {
  to: (path: string) => { left: string; search: SplitSearch };
  href: (path: string) => string;
};

export const PaneLinks = createContext<PaneLinks | null>(null);

/** Opens folders in the pane around the caller, or as the page's folder outside a split. */
export function usePaneHref(): (path: string) => string {
  return useContext(PaneLinks)?.href ?? fileHref;
}
