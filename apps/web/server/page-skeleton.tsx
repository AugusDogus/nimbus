import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Bootstrap } from "@/client/bootstrap";
import { FilesSkeleton, SettingsSkeleton } from "@/app/page-skeletons";
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

// Rendered once; they never vary by request.
const markup = {
  filesList: placeholder(<FilesSkeleton view="list" />),
  filesGrid: placeholder(<FilesSkeleton view="grid" />),
  filesPage: placeholder(<FilesSkeleton view={null} />),
  settings: placeholder(<SettingsSkeleton />),
};

export const PageSkeleton = {
  /**
   * The placeholder a page shows until its code runs, or "" for pages without one. Signed-in
   * pages get theirs only once the server has seen a session, so a signed-out visitor never
   * sees signed-in chrome.
   */
  markup(
    kind: PageKind | null,
    page: { folder: boolean; data: Bootstrap },
  ): string {
    switch (kind) {
      case "files":
        if (!page.folder) return markup.filesPage;
        return page.data.prefs?.view === "grid"
          ? markup.filesGrid
          : markup.filesList;
      case "settings":
        return markup.settings;
      default:
        return "";
    }
  },
} as const;
