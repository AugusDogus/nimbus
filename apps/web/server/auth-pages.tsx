import { AuthPageData } from "@/app/auth/auth-page-data";
import { AuthScreen } from "@/app/auth/auth-screen";
import { CallbackUrl } from "@/lib/callback-url";
import { createQueryClient } from "@/lib/query-client";
import type { AppShell } from "./app-shell";
import { PageBootstrap } from "./page-bootstrap";
import { PublicPages } from "./public-pages";
import type { SecurityMode } from "./security-headers";

/** A sign-in page to send, or the address to send the visitor to instead. */
export type AuthPageResponse =
  | { kind: "page"; html: string; headers: Headers }
  | { kind: "redirect"; location: string };

const redirect = (location: string): AuthPageResponse => ({
  kind: "redirect",
  location,
});

/**
 * The sign-in, sign-up and password reset pages, rendered on the server so a signed-out visitor
 * sees and can use the form with the HTML, then hydrated through their own entry, which loads
 * nothing of the signed-in app. What each page offers comes from the `signIn.options`
 * procedure the app used to ask, read here once per request.
 */
export const AuthPages = {
  async render(
    request: Request,
    url: URL,
    shell: AppShell,
    mode: SecurityMode,
  ): Promise<AuthPageResponse | null> {
    const { pathname, searchParams } = url;
    if (pathname === "/sign-in") return redirect("/login");
    if (
      pathname !== "/login" &&
      pathname !== "/signup" &&
      pathname !== "/reset-password"
    )
      return null;
    const { caller, session } = await PageBootstrap.forRequest(request);
    const options = await caller.signIn.options();
    let data: AuthPageData;
    if (pathname === "/login") {
      // Someone already signed in goes where signing in would have taken them.
      if (session)
        return redirect(CallbackUrl.parse(searchParams.get("callbackURL")));
      data = AuthPageData.signIn(options, searchParams);
    } else if (pathname === "/signup") {
      // Registration is open only until the first account exists.
      if (!options.setupAvailable) return redirect("/login");
      data = { page: "sign-up" };
    } else {
      if (!options.passwordReset) return redirect("/login");
      data = AuthPageData.resetPassword(searchParams);
    }
    const page = await PublicPages.page(
      "auth",
      shell,
      mode,
      createQueryClient(),
      [],
      { data, content: <AuthScreen data={data} />, title: null },
    );
    return { kind: "page", ...page };
  },
} as const;
