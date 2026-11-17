import { expect, test } from "bun:test";
import { AuthPageData } from "./auth-page-data";

const options = {
  setupAvailable: false,
  singleSignOn: "Authentik",
  passwordReset: true,
};

test("sign-in carries single sign-on errors and a destination that stays on the site", () => {
  const page = AuthPageData.signIn(
    options,
    new URLSearchParams({ error: "banned", callbackURL: "/oauth/consent?x=1" }),
  );
  expect(page).toEqual({
    page: "sign-in",
    options,
    error:
      "This account is disabled. Ask your server administrator to enable it.",
    redirectTo: "/oauth/consent?x=1",
  });
  expect(AuthPageData.parse(JSON.parse(JSON.stringify(page)))).toEqual(page);
  const offSite = AuthPageData.signIn(
    options,
    new URLSearchParams({ callbackURL: "//evil.example" }),
  );
  expect(offSite).toMatchObject({ error: null, redirectTo: "/" });
  expect(
    AuthPageData.parse({ ...page, redirectTo: "https://evil.example" }),
  ).toMatchObject({ redirectTo: "/" });
});

test("password reset reads the emailed token and a stale-token error", () => {
  const page = AuthPageData.resetPassword(
    new URLSearchParams({ token: "t", error: "INVALID_TOKEN" }),
  );
  expect(page).toEqual({ page: "reset-password", token: "t", expired: true });
  expect(AuthPageData.parse(page)).toEqual(page);
});

test("malformed page data is refused", () => {
  for (const value of [
    null,
    { page: "sign-in", options, error: 1, redirectTo: "/" },
    { page: "reset-password", token: null },
    { page: "somewhere" },
  ])
    expect(AuthPageData.parse(value)).toBeUndefined();
  expect(AuthPageData.parse({ page: "sign-up" })).toEqual({ page: "sign-up" });
});

test("sign-in explains the single sign-on refusals Nimbus sends back", () => {
  const message = (error: string) => {
    const page = AuthPageData.signIn(options, new URLSearchParams({ error }));
    return page.page === "sign-in" ? page.error : null;
  };
  expect(message("email_not_verified")).toContain(
    "Authentik has not verified your email address",
  );
  expect(message("administrator_required")).toContain("no administrator yet");
});
