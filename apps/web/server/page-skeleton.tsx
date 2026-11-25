import { ListOrder } from "@/app/drive/files/list-order";
import { TrashOrder } from "@/app/drive/trash/trash-order";
import { SearchTitle } from "@/app/drive/search/search-title";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Bootstrap } from "@/client/bootstrap";
import {
  FilesSkeleton,
  SettingsSkeleton,
  type FilesPageSkeleton,
} from "@/app/page-skeletons";
import { NavPlace } from "@/app/drive/files/nav-place";
import { AppFrame } from "@/components/app-frame";
import { PageLayout } from "@/components/page-layout";
import type { PageKind } from "./route-preloads";

/**
 * A placeholder that only looks like the page: hidden from assistive technology and inert, so
 * its landmarks, labels and links neither speak nor take input before the app replaces it.
 */
const placeholder = (page: ReactNode) =>
  renderToStaticMarkup(
    <div inert aria-hidden="true" data-skeleton="">
      {page}
    </div>,
  );

/** What each files page other than a folder starts with (see `FilesPageSkeleton`). */
const pages = new Map<string, FilesPageSkeleton>([
  ["/trash", "trash"],
  ["/recent", "recent"],
  ["/starred", "starred"],
  ["/search", "search"],
]);

/**
 * Markup already rendered, by everything it depends on. Few combinations occur, as accounts
 * share sort orders, views and places, so this stays small; it is bounded all the same.
 */
const rendered = new Map<string, string>();
const limit = 256;

function cached(key: string, render: () => ReactNode) {
  const hit = rendered.get(key);
  if (hit !== undefined) return hit;
  const markup = placeholder(render());
  if (rendered.size >= limit) rendered.clear();
  rendered.set(key, markup);
  return markup;
}

export const PageSkeleton = {
  /**
   * The placeholder a page shows until its code runs, or "" for pages without one. Signed-in
   * pages get theirs only once the server has seen a session, so a signed-out visitor never
   * sees signed-in chrome. It shows what the server knows: the account's initial and role, its
   * sort order and view, and which page it is.
   */
  markup(
    kind: PageKind | null,
    page: { folder: boolean; data: Bootstrap },
    pathname: string,
    cookie: string | null,
    /** The address's params: the order a page's sort control shows, and what a search is for. */
    params: URLSearchParams,
  ): string {
    const sort = params.get("sort");
    const { session, prefs, me } = page.data;
    if (!session || (kind !== "files" && kind !== "settings")) return "";
    const account = {
      initial: PageLayout.initial(session.user),
      isAdmin: me?.isAdmin === true,
      sidebarOpen: AppFrame.SidebarChoice.fromCookie(cookie),
    };
    if (kind === "settings")
      return cached(JSON.stringify(["settings", account, pathname]), () => (
        <SettingsSkeleton account={account} path={pathname} />
      ));
    const place = NavPlace.of(pathname);
    if (page.folder && prefs)
      return cached(JSON.stringify(["folder", account, place, prefs]), () => (
        <FilesSkeleton
          account={account}
          place={place}
          page={{ kind: "folder", prefs }}
        />
      ));
    const shows = pages.get(pathname) ?? "shared";
    const other = {
      kind: "page" as const,
      shows,
      view: prefs?.view ?? "list",
      // Named by the page's own choices, so odd addresses share the default's markup.
      // A search's results are titled by what it looks for, which may take more than a line.
      title:
        shows === "search"
          ? SearchTitle.of(params.get("q")?.trim() ?? "")
          : undefined,
      sort:
        shows === "shared"
          ? undefined
          : shows === "trash"
            ? TrashOrder.pick(sort ?? undefined).value
            : ListOrder.pick(shows, sort ?? undefined).value,
    };
    return cached(JSON.stringify(["page", account, place, other]), () => (
      <FilesSkeleton account={account} place={place} page={other} />
    ));
  },
} as const;
