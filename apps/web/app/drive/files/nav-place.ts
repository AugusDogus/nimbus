/**
 * The sidebar item a page belongs to: "files" for every folder view, wherever it is in the
 * drive, or one of the library pages.
 */
export type NavPlace =
  | "files"
  | "shared"
  | "recent"
  | "starred"
  | "trash"
  | "settings";

const pages = new Map<string, NavPlace>([
  // Redirects to the account's home folder, a folder view like any other.
  ["/home", "files"],
  ["/shared", "shared"],
  ["/recent", "recent"],
  ["/starred", "starred"],
  ["/trash", "trash"],
  ["/settings", "settings"],
]);

const isFolderPage = (pathname: string) =>
  pathname === "/" || pathname === "/browse" || pathname.startsWith("/browse/");

export const NavPlace = {
  /** The item for the page at `pathname`, or null when it belongs to none, such as search. */
  of(pathname: string): NavPlace | null {
    // The router serves `/shared/` as `/shared` and marks links to it current, so match it too.
    const page = pathname.replace(/(?<=.)\/+$/, "");
    if (isFolderPage(page)) return "files";
    return pages.get(page) ?? null;
  },
} as const;
