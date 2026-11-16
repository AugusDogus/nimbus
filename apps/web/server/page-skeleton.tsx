import { renderToStaticMarkup } from "react-dom/server";
import type { UserPreferences } from "@nimbus/api/context";
import {
  AuthSkeleton,
  FilesSkeleton,
  SettingsSkeleton,
} from "@/app/page-skeletons";
import type { PageKind } from "./route-preloads";

// Rendered once; they never vary by request.
const markup = {
  filesList: renderToStaticMarkup(<FilesSkeleton view="list" />),
  filesGrid: renderToStaticMarkup(<FilesSkeleton view="grid" />),
  filesPage: renderToStaticMarkup(<FilesSkeleton view={null} />),
  settings: renderToStaticMarkup(<SettingsSkeleton />),
  auth: renderToStaticMarkup(<AuthSkeleton />),
};

export const PageSkeleton = {
  /**
   * The placeholder a page shows until its code runs, or "" for pages without one. Signed-in
   * pages get theirs only once the server has seen a session, so a signed-out visitor never
   * sees signed-in chrome.
   */
  markup(
    kind: PageKind | null,
    folder: boolean,
    prefs: UserPreferences | undefined,
  ): string {
    switch (kind) {
      case "files":
        if (!folder) return markup.filesPage;
        return prefs?.view === "grid" ? markup.filesGrid : markup.filesList;
      case "settings":
        return markup.settings;
      case "auth":
        return markup.auth;
      default:
        return "";
    }
  },
} as const;
