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

export const SplitRoom = {
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
} as const;
