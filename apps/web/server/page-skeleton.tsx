import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { Bootstrap } from "@/client/bootstrap";
import { AuthPage } from "@/app/auth/auth-page";
import { LoginForm } from "@/components/login-form";
import { FilesSkeleton, SettingsSkeleton } from "@/app/page-skeletons";
import type { PageKind } from "./route-preloads";

// Rendered once; they never vary by request.
const markup = {
  filesList: renderToStaticMarkup(<FilesSkeleton view="list" />),
  filesGrid: renderToStaticMarkup(<FilesSkeleton view="grid" />),
  filesPage: renderToStaticMarkup(<FilesSkeleton view={null} />),
  settings: renderToStaticMarkup(<SettingsSkeleton />),
};

type SignInOptions = NonNullable<Bootstrap["signInOptions"]>;

// Links need a router to build their addresses; this one only ever names the sign-in page.
const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/login"] }),
});

const signInCards = new Map<string, string>();

/**
 * The sign-in page as the app first renders it, from the same components, so nothing moves
 * when the app replaces it. It is inert, so nothing typed before then is lost.
 */
function signIn(options: SignInOptions) {
  const key = JSON.stringify(options);
  const cached = signInCards.get(key);
  if (cached !== undefined) return cached;
  const html = renderToStaticMarkup(
    <div inert>
      <RouterContextProvider router={router}>
        <AuthPage>
          <LoginForm {...options} />
        </AuthPage>
      </RouterContextProvider>
    </div>,
  );
  signInCards.set(key, html);
  return html;
}

export const PageSkeleton = {
  /**
   * The placeholder a page shows until its code runs, or "" for pages without one. Signed-in
   * pages get theirs only once the server has seen a session, so a signed-out visitor never
   * sees signed-in chrome. Sign-in shows its real card; other sign-in pages and sign-in with
   * an error to show vary too much to stand in for, so they show only the background.
   */
  markup(
    kind: PageKind | null,
    url: URL,
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
      case "auth":
        return url.pathname === "/login" &&
          !url.searchParams.has("error") &&
          page.data.signInOptions
          ? signIn(page.data.signInOptions)
          : "";
      default:
        return "";
    }
  },
} as const;
