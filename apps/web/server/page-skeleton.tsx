import type { ReactNode } from "react";
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

type SignInOptions = NonNullable<Bootstrap["signInOptions"]>;

// Links need a router to build their addresses; this one only ever names the sign-in page.
const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/login"] }),
});

const signInCards = new Map<string, string>();

/**
 * Hides everything inside the card while keeping the space it takes. It is inline so it holds
 * before the app's stylesheet arrives, which in development comes with the app's code.
 */
const cardContentHidden =
  "<style>[data-skeleton] [data-slot=card]>*{visibility:hidden}</style>";

/**
 * The sign-in page laid out as the app first renders it, from the same components, so nothing
 * moves when the app replaces it. Only the logo and an empty card of the right size show: its
 * fields stay hidden, so neither people, autofill nor scripts can type into fields that are
 * about to be replaced.
 */
function signIn(options: SignInOptions) {
  const key = JSON.stringify(options);
  const cached = signInCards.get(key);
  if (cached !== undefined) return cached;
  const html =
    cardContentHidden +
    placeholder(
      <RouterContextProvider router={router}>
        <AuthPage>
          <LoginForm {...options} />
        </AuthPage>
      </RouterContextProvider>,
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
