import { cn } from "@/lib/utils";
import { PageSurface } from "./page-surface";

/**
 * The parts of a signed-in page around its content: the header and the content area, for the
 * files pages and for Settings. The pages and their skeletons, which the server sends before the
 * app runs, share these, so a page never moves when the app replaces its skeleton.
 */
export const PageLayout = {
  /**
   * The files pages' header. From 768 px its ends line up with the content card's edges, the
   * sidebar toggle at its left and the account menu at its right, open or closed, and the search
   * is centred on the window (see `searchPlace`).
   */
  filesHeader: cn(
    PageSurface.header,
    "sticky top-0 z-20 flex h-16 shrink-0 items-center gap-2 px-4 md:gap-4 md:px-0",
    // On touch screens its ends keep the room their 44 px touch areas reach past them.
    "md:pointer-coarse:px-1.5 md:pointer-coarse:[--header-pad:0.375rem]",
    // Where the search may go, in the window's coordinates: from the end of the header's left
    // part to the start of its right part, a gap clear of each (`--start-edge`, `--end-edge`,
    // which the header sets as it moves with the sidebar, and its own left, `--header-left`).
    "md:[--search-l:max(var(--start-edge),calc(50vw-18rem))] md:[--search-r:min(var(--end-edge),calc(50vw+18rem))]",
  ),
  /**
   * The search's place from 768 px: up to 36 rem centred on the window, so it stays put when the
   * sidebar opens or closes. Where the header's ends come within reach it gives way on that side
   * instead of covering them.
   */
  searchPlace:
    "md:absolute md:top-1/2 md:-translate-y-1/2 md:left-[calc(var(--search-l)-var(--header-left))] md:w-[calc(var(--search-r)-var(--search-l))]",
  /** The sidebar toggle and, on phones, the logo, 44 px apart so their touch areas do not overlap. */
  filesHeaderStart:
    "flex shrink-0 items-center gap-2 max-md:pointer-coarse:gap-3.5 md:gap-4",
  /** The page's own tools, such as the split view toggle, then the account menu. */
  filesHeaderEnd: "flex shrink-0 items-center gap-1 md:ml-auto md:gap-3",
  /** Settings' header: the sidebar toggle and the breadcrumb. */
  settingsHeader: cn(
    PageSurface.header,
    "sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3 px-4 md:px-0 md:pointer-coarse:px-1.5",
  ),
  sidebarTrigger: "touch-hit size-8 shrink-0 text-muted-foreground",
  logo: "size-7",
  account: "touch-hit relative size-9 rounded-full",
  avatarFallback: "bg-secondary text-secondary-foreground",
  /**
   * A primary button in the create colour, such as New: the primary button takes its colours from
   * `--primary` and `--primary-foreground` (see globals.css), so this points them at create's.
   */
  createButton:
    "[--primary:var(--create)] [--primary-foreground:var(--create-foreground)]",
  /** The letter the account menu shows: the name's first, else the email's. */
  initial: (user: { name?: string | null; email?: string | null }) =>
    user.name?.charAt(0).toUpperCase() ||
    user.email?.charAt(0).toUpperCase() ||
    "U",
  /**
   * The files pages' content: a folder lays out its own card, or one per pane; other pages sit on
   * one card here.
   */
  filesContent: (folder: boolean) =>
    cn(
      "flex-1 overflow-x-clip px-4 pb-24 pt-6",
      // A folder's area is the room a split view measures (see `SplitRoom`). On phones it is
      // the page and scrolls with it; holding a split's panes, it is as tall as the window below
      // the header, and each pane scrolls on its own.
      folder
        ? "@container/room md:flex md:min-h-0 md:flex-col md:p-0 max-md:has-[>[data-split-view=swipe]]:flex max-md:has-[>[data-split-view=swipe]]:h-[calc(100dvh-4rem)] max-md:has-[>[data-split-view=swipe]]:flex-col max-md:has-[>[data-split-view=swipe]]:pt-3 max-md:has-[>[data-split-view=swipe]]:pb-3"
        : cn(PageSurface.card, "md:px-6 md:pb-6 lg:px-8 lg:pt-8"),
    ),
  settingsContent: cn("flex-1", PageSurface.card),
  settingsColumn: "mx-auto w-full max-w-4xl px-4 py-6 md:px-6 lg:px-8 lg:py-8",
  /** A page's title, such as Trash's or a settings page's. */
  title: "text-balance text-2xl font-semibold",
} as const;
