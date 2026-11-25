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
    if (action === "sort" || action === "change view")
      return "Not built yet: search results keep their relevance order, and Recent, Starred and Shared their own, always as a list.";
  }
  return null;
}

export const FileAction = { all, views, names, unavailable } as const;
