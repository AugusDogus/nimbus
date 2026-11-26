/**
 * What kind of split view a screen gets: two panes side by side where they fit, elsewhere one at
 * a time, swiped between. Every folder offers one, at every width, by its toggle, its item menus
 * and the `|` key. The split view measures its content area against `fits`; before it loads,
 * Back and Up and the split's code follow the same numbers (`roomOnly`, `minViewport`).
 */

/** Narrowest useful pane, in pixels: list rows keep their names, and grid cards two columns. */
const minPaneWidth = 360;
/** The gap between the two pane cards, which is the divider. */
const dividerWidth = 8;
/** The narrowest content area, in pixels, that holds two panes side by side. */
const minSideBySide = 2 * minPaneWidth + dividerWidth;
/**
 * Below this content width, in pixels, a split folds the sidebar away when that gives the panes
 * more room, as wide windows do not need to.
 */
const roomy = 900;
/**
 * The narrowest window, in pixels, whose content area is that wide once the sidebar has folded
 * away. Below 768 px the folder keeps 16 px from each edge of the window; from 768 px the content
 * card keeps 8 px, so any window wide enough at the narrower margin is wide enough there too.
 */
const minViewport = minSideBySide + 32;

/**
 * How a split view lays out its two panes: side by side where they fit, elsewhere one at a time,
 * swiped between. Every folder page offers a split at every width; pages that are not a folder
 * offer none (`SplitControl`'s "none").
 */
export type SplitMode = "side-by-side" | "swipe";

/**
 * The mode for a content area `contentWidth` px wide, where folding the sidebar away would add
 * `foldWidth` px (0 where there is no sidebar column to fold, as on phones).
 */
const mode = (contentWidth: number, foldWidth: number): SplitMode =>
  contentWidth + foldWidth >= minSideBySide ? "side-by-side" : "swipe";

/**
 * The mode a window `width` px wide gets once the split has folded the sidebar if it needs to:
 * what a test or anything else without a measured content area can ask.
 */
const modeForWindow = (width: number): SplitMode =>
  width >= minViewport ? "side-by-side" : "swipe";

/**
 * The mode this browser window gets, read from the window itself before any content area is
 * measured, as when deciding whether to load the split view's code early.
 */
const modeOfThisWindow = (): SplitMode =>
  matchMedia(`(min-width: ${minViewport}px)`).matches
    ? "side-by-side"
    : "swipe";

export const SplitRoom = {
  mode,
  modeForWindow,
  modeOfThisWindow,
  minPaneWidth,
  dividerWidth,
  minSideBySide,
  minViewport,
  roomy,
  /** Whether a content area this wide, in pixels, holds two panes side by side. */
  fits: (contentWidth: number) => contentWidth >= minSideBySide,
  /**
   * Hides what lines a folder up with a split view's left pane, Back and Up, while the page's
   * content area (`room`, see `PageLayout.filesContent`) is narrower than two panes.
   */
  roomOnly: "@max-[727px]/room:hidden",
  /**
   * Hides what only a window showing one pane at a time offers, from `minViewport` up: a folder
   * card's own Split, where a thumb reaches it.
   */
  // reach: wider windows open a split from the header's Split view toggle (`sideBySideOnly`).
  swipeOnly: "min-[760px]:hidden",
  /** Hides what only a window with room for two panes offers, below `minViewport`. */
  // reach: narrower windows open a split from the folder card's own Split (`swipeOnly`).
  sideBySideOnly: "max-[759px]:hidden",
} as const;
