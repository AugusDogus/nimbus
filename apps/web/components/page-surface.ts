/**
 * The surfaces of a signed-in page. From 768 px the page area is the window's own tint: the
 * header sits on it, and the content on a raised white card below, one per folder in a split
 * view. On phones the header stays attached to the page, which scrolls as one, so no space goes
 * to margins and shadows.
 */
export const PageSurface = {
  /** The page header: attached on phones, on the window's tint from 768 px. */
  header:
    "surface-grain border-b border-border/40 bg-background md:border-transparent md:bg-transparent md:bg-none",
  /** The raised card, white, ringed and lifted off the tint, from 768 px (a split view's active
   * pane wears it at every width, see `paneCard`). */
  raisedFromTablet:
    "md:rounded-xl md:bg-card md:ring-1 md:ring-border/80 md:shadow-raised md:dark:ring-white/[0.08]",
  /** A page's content card, which scrolls on its own from 768 px. */
  card: "md:min-h-0 md:flex-1 md:overflow-y-auto md:[scrollbar-gutter:stable] md:rounded-xl md:bg-card md:ring-1 md:ring-border/80 md:shadow-raised md:dark:ring-white/[0.08]",
} as const;
