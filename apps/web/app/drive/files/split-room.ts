/**
 * Whether two panes of a split view fit side by side: the one rule the split view, its toggle,
 * the folder's Back and Up, and the page's skeleton all follow. The split view measures its
 * content area; before it loads, CSS reads the same numbers (`toggleOnly`, `roomOnly`).
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

export const SplitRoom = {
  minPaneWidth,
  dividerWidth,
  minSideBySide,
  minViewport,
  roomy,
  /** Whether a content area this wide, in pixels, holds two panes side by side. */
  fits: (contentWidth: number) => contentWidth >= minSideBySide,
  /**
   * Hides the split view's toggle in windows narrower than `minViewport`, where two panes cannot
   * fit even with the sidebar folded. Class names Tailwind must see whole are written out here;
   * split-room.test.ts checks their numbers.
   */
  toggleOnly: "max-[759px]:hidden",
  /**
   * Hides what lines a folder up with a split view's left pane, Back and Up, while the page's
   * content area (`room`, see `PageLayout.filesContent`) is narrower than two panes.
   */
  roomOnly: "@max-[727px]/room:hidden",
  /** The room the header's end takes in a page's skeleton: the account menu, and the toggle. */
  headerEnd: "[--end-w:2.25rem] min-[760px]:[--end-w:4.75rem]",
} as const;
