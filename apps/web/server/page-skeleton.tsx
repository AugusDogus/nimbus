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
  ["/recent", "library"],
  ["/starred", "library"],
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
  ): string {
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
    const other = {
      kind: "page" as const,
      shows: pages.get(pathname) ?? "shared",
    };
    return cached(JSON.stringify(["page", account, place, other]), () => (
      <FilesSkeleton account={account} place={place} page={other} />
    ));
  },
} as const;
