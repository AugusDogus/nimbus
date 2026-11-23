import { cn } from "@/lib/utils";
import { PageSurface } from "./page-surface";

/**
 * The parts of a signed-in page around its content: the header and the content area, for the
 * files pages and for Settings. The pages and their skeletons, which the server sends before the
 * app runs, share these, so a page never moves when the app replaces its skeleton.
 */
export const PageLayout = {
  /**
   * The files pages' header. From 768 px, three columns: search keeps to the middle one, centred
   * over the page. The sides share one minimum, room for the split view toggle and the account
   * menu, so the search stays put whichever page adds a tool.
   */
  filesHeader: cn(
    PageSurface.header,
    "sticky top-0 z-20 flex h-16 shrink-0 items-center gap-2 px-4 md:grid md:grid-cols-[minmax(5.5rem,1fr)_minmax(0,36rem)_minmax(5.5rem,1fr)] md:gap-4 md:px-6",
  ),
  /** The sidebar toggle and, on phones, the logo, 44 px apart so their touch areas do not overlap. */
  filesHeaderStart:
    "flex shrink-0 items-center gap-2 max-md:pointer-coarse:gap-3.5 md:gap-4",
  /** The page's own tools, such as the split view toggle, then the account menu. */
  filesHeaderEnd:
    "flex shrink-0 items-center gap-1 md:justify-self-end md:gap-3",
  /** Settings' header: the sidebar toggle and the breadcrumb. */
  settingsHeader: cn(
    PageSurface.header,
    "sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3 px-4 md:px-6",
  ),
  sidebarTrigger: "touch-hit size-8 shrink-0 text-muted-foreground",
  logo: "size-7",
  account: "touch-hit relative size-9 rounded-full",
  avatarFallback: "bg-secondary text-secondary-foreground",
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
      folder
        ? "md:flex md:min-h-0 md:flex-col md:p-0"
        : cn(PageSurface.card, "md:px-6 md:pb-6 lg:px-8 lg:pt-8"),
    ),
  settingsContent: cn("flex-1", PageSurface.card),
  settingsColumn: "mx-auto w-full max-w-4xl px-4 py-6 md:px-6 lg:px-8 lg:py-8",
  /** A page's title, such as Trash's or a settings page's. */
  title: "text-balance text-2xl font-semibold",
} as const;
