import { useSearch } from "@tanstack/react-router";
import { usePathname } from "@/hooks/use-pathname";
import { FolderPath } from "./folder-path";
import { validateSplitSearch } from "./split-search";

export type { SplitSearch } from "./split-search";

/** One of the two panes of a split view. */
export type PaneSide = "left" | "right";

/**
 * A split view as the address holds it. The pathname is the left pane's folder; the search
 * params name the right pane's folder, the pane commands act on, the left pane's share of the
 * width in percent, and a pane folded away. Without `right` the page shows one folder.
 */
export type SplitLayout = {
  right: string;
  active: PaneSide;
  ratio: number;
  collapsed: PaneSide | null;
};

/**
 * The other pane's folder, offered as a destination for the selection: in the selection bar, the
 * move and copy picker, and the item menus. `writable` is false until its permissions arrive.
 */
export type OtherPane = {
  path: string;
  label: string;
  writable: boolean;
  /** Where the other pane is, for arrows that point at it. */
  side: PaneSide;
};

/**
 * What a listing offers for split view: nothing, on pages that are not a folder; opening one,
 * with the folder for the right pane or null to choose (see `openSplit`); or, in a split, closing
 * it, opening a folder in the other pane, and moving focus there while it shows beside this one.
 */
export type SplitControl =
  | { kind: "none" }
  | {
      kind: "closed";
      open: (right: string | null) => void;
      /**
       * A finger went down on Split, which may open a split: what it would show is prepared out
       * of sight (see `SplitPress`).
       */
      press: (event: PointerEvent, button: HTMLElement) => void;
    }
  | {
      kind: "open";
      close: () => void;
      openInOther: (path: string) => void;
      focusOther: (() => void) | null;
    };

const ratioBounds = { min: 10, max: 90, initial: 50 } as const;

/** A folder path from the address, `a/b`, or null for one that climbs out (`..`). */
function folderOf(value: string): string | null {
  const segments = value.split("/").filter(Boolean);
  return segments.some((segment) => segment === "." || segment === "..")
    ? null
    : segments.join("/");
}

const sideOf = (value: string | undefined): PaneSide | null =>
  value === "left" || value === "right" ? value : null;

const other = (side: PaneSide): PaneSide =>
  side === "left" ? "right" : "left";

const clampRatio = (ratio: number) =>
  Math.min(ratioBounds.max, Math.max(ratioBounds.min, Math.round(ratio)));

/**
 * The split the params describe, or null for one folder. Bad values fall back to defaults.
 * Writing them back is `SplitAddress`, which loads with the split view.
 */
function parse(search: Record<string, unknown>): SplitLayout | null {
  const {
    right: rawRight,
    active,
    ratio,
    collapsed,
  } = validateSplitSearch(search);
  if (rawRight === undefined) return null;
  const right = folderOf(rawRight);
  if (right === null) return null;
  const folded = sideOf(collapsed);
  const number = ratio === undefined || ratio.trim() === "" ? NaN : +ratio;
  const requested = sideOf(active) ?? "left";
  return {
    right,
    // A folded pane cannot take commands; the open one does.
    active: folded === requested ? other(requested) : requested,
    ratio: Number.isFinite(number) ? clampRatio(number) : ratioBounds.initial,
    collapsed: folded,
  };
}

/** The folder a pane shows. */
const pathOf = (left: string, layout: SplitLayout, side: PaneSide) =>
  side === "left" ? left : layout.right;

/**
 * The folder New, Upload and the page's other commands act on: the active pane's in a split,
 * otherwise the one folder shown.
 */
const activePath = (left: string, layout: SplitLayout | null) =>
  layout ? pathOf(left, layout, layout.active) : left;

export const SplitLayout = {
  ratioBounds,
  parse,
  pathOf,
  activePath,
  other,
  folderOf,
} as const;

/** The split view the address holds on a folder page, or null for one folder. */
export function useSplitLayout(): SplitLayout | null {
  const search = useSearch({ strict: false });
  const pathname = usePathname();
  return FolderPath.isShownAt(pathname) ? SplitLayout.parse(search) : null;
}
