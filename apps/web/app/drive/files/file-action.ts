import type { Device } from "@/lib/device";
import type { SplitMode } from "./split-room";

/**
 * What a person can do with files, and the views they do it in. The reach check
 * (`e2e/reach.e2e.ts`) expects every action in every view, on every device, to have at least one
 * visible route, and fails on any gap not declared in `FileAction.unavailable`.
 */
export type FileAction =
  | "open"
  | "preview"
  | "rename"
  | "move"
  | "copy"
  | "share"
  | "download"
  | "star"
  | "trash"
  | "select one"
  | "select many"
  | "select all"
  | "sort"
  | "change view"
  | "new folder"
  | "upload"
  | "search";

export type FileView =
  | "files list"
  | "files grid"
  | "search results"
  | "recent"
  | "starred"
  | "shared"
  | "trash";

const all: readonly FileAction[] = [
  "open",
  "preview",
  "rename",
  "move",
  "copy",
  "share",
  "download",
  "star",
  "trash",
  "select one",
  "select many",
  "select all",
  "sort",
  "change view",
  "new folder",
  "upload",
  "search",
];

const views: readonly FileView[] = [
  "files list",
  "files grid",
  "search results",
  "recent",
  "starred",
  "shared",
  "trash",
];

/**
 * The accessible names the app gives each action's controls, on any surface: an item menu, the
 * actions drawer, the selection bar, the New menu or the page's toolbar. Selecting is a gesture
 * (a hover's circle, a long-press, a modifier click), so it has no names here.
 */
const names: Readonly<Record<FileAction, readonly RegExp[]>> = {
  open: [],
  preview: [/^Preview$/],
  rename: [/^Rename$/],
  move: [/^Move to…$/, /^Move$/],
  copy: [/^Copy to…$/, /^Copy$/],
  share: [/^Share$/],
  download: [/^Download( ZIP| \d[\d,]* items)?$/],
  star: [/^(Star|Remove star|Remove stars|Star all)$/],
  trash: [/^Move to trash$/, /^Trash$/],
  "select one": [],
  "select many": [],
  "select all": [/^Select all$/],
  sort: [/^Sort files$/, /^Sort and filter options$/],
  "change view": [/^Grid view$/, /^List view$/],
  "new folder": [/^New folder$/, /^Folder$/],
  upload: [/^Upload files?$/, /^Upload folder$/, /^Upload$/],
  search: [/^Search files$/],
};

const libraries: readonly FileView[] = [
  "search results",
  "recent",
  "starred",
  "shared",
];

/**
 * Where an action is genuinely not offered, and why: the one place such a gap is declared. Null
 * where the action should be reachable. Nothing here depends on the device today: every action
 * that a view offers is meant to be reachable with a finger, a mouse or a keyboard, at every
 * width. A gap that comes to depend on it takes the `Device` that `Device.read` answers in the
 * browser, which the reach check already reads.
 */
function unavailable(action: FileAction, view: FileView): string | null {
  if (view === "trash")
    return action === "search"
      ? null
      : "Trash holds deleted items: it offers Restore and Delete permanently, and every other action needs the item restored first.";
  if (libraries.includes(view)) {
    if (action === "new folder" || action === "upload")
      return "Not a folder: there is no folder here to create in or upload to.";
  }
  return null;
}

/** What a person does with a split view of two folders. */
export type SplitAction =
  | "open split"
  | "close split"
  | "switch pane"
  | "see both panes"
  | "move to other pane"
  | "copy to other pane"
  | "select all in pane"
  | "resize panes"
  | "collapse pane"
  | "drag to other pane";

const splitActions: readonly SplitAction[] = [
  "open split",
  "close split",
  "switch pane",
  "see both panes",
  "move to other pane",
  "copy to other pane",
  "select all in pane",
  "resize panes",
  "collapse pane",
  "drag to other pane",
];

/**
 * Where a split view's action is genuinely not offered, and why, by the split's mode (see
 * `SplitRoom`) and the device (see `Device`). Null where it should be reachable.
 */
function unavailableInSplit(
  action: SplitAction,
  mode: SplitMode,
  device: Device,
): string | null {
  if (
    mode === "swipe" &&
    (action === "see both panes" ||
      action === "resize panes" ||
      action === "collapse pane")
  )
    return "One pane at a time: there is no room for two side by side, so neither sits beside the other to see, resize or collapse; the switcher and a swipe move between them.";
  if (action === "drag to other pane" && !device.anyFine)
    return "A finger never drags files in Nimbus, so it cannot scroll by mistake into a move: Move to and Copy to the other pane do it from the selection bar.";
  return null;
}

export const FileAction = {
  all,
  views,
  names,
  unavailable,
  splitActions,
  unavailableInSplit,
} as const;
