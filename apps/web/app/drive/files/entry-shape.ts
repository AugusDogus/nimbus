/**
 * The classes that give a listing's rows, cards and section titles their shape. The listing and
 * its skeletons share them, with `entryGeometry` for the sizes the layout computes, so a skeleton
 * keeps step with the entries that replace it.
 */
export const EntryShape = {
  /** A section's title, such as "Folders", in its row of `entryGeometry.header.height`. */
  title: "px-3 text-balance text-xs font-medium text-muted-foreground",
  /** What every entry's link or button shares, in list and grid view. */
  entry:
    "w-full rounded-lg text-left [-webkit-touch-callout:none] focus-visible:outline-2 focus-visible:outline-ring",
  listRow: "flex h-12 items-center gap-3 py-3 pl-3 pr-12",
  listIcon: "relative flex size-5 shrink-0 items-center justify-center",
  listName: "min-w-0 truncate text-sm",
  card: "relative flex h-full flex-col overflow-hidden border",
  cardPicture: "min-h-0 w-full flex-1 bg-muted/40",
  /**
   * The name's area always holds two lines, a one-line name centred in it, so every card's
   * picture keeps the same height whatever its name.
   */
  cardName: "mx-3 my-2 flex h-10 shrink-0 items-center justify-center",
  /** The entry's actions button, at its top right; it shows on hover only with a fine pointer. */
  actions:
    "absolute right-2 top-2 shrink-0 pointer-coarse:right-0.5 pointer-coarse:top-0.5 pointer-coarse:size-11",
} as const;
