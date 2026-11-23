import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { AuthPageData } from "./auth-page-data";
import { AuthScreen } from "./auth-screen";

const render = (data: AuthPageData) =>
  renderToString(<AuthScreen data={data} />);

test("sign-in renders each option the server reports, with actions off until hydrated", () => {
  const offered = render(
    AuthPageData.signIn(
      { setupAvailable: true, singleSignOn: "Authentik", passwordReset: true },
      new URLSearchParams({ error: "email_not_verified" }),
    ),
  );
  expect(offered).toMatch(/Continue with (<!-- -->)?Authentik/);
  expect(offered).toContain('href="/signup"');
  expect(offered).toContain('href="/reset-password"');
  expect(offered).toContain("Authentik has not verified your email address");
  // A disabled button holding the label, which sits in the button's own inner layers.
  expect(offered).toMatch(
    /<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Sign in with a passkey/,
  );

  const plain = render(
    AuthPageData.signIn(
      { setupAvailable: false, singleSignOn: null, passwordReset: false },
      new URLSearchParams(),
    ),
  );
  expect(plain).not.toContain("Continue with");
  expect(plain).not.toContain('href="/signup"');
  expect(plain).not.toContain('href="/reset-password"');
  expect(plain).toContain("Need an account? Ask your server administrator.");
  expect(plain).not.toContain('role="alert"');
});

test("sign-up and password reset render their forms", () => {
  expect(render({ page: "sign-up" })).toContain("Confirm Password");
  expect(
    render({ page: "reset-password", token: null, expired: true }),
  ).toContain("That reset link has expired or was already used.");
  expect(
    render({ page: "reset-password", token: "t", expired: false }),
  ).toContain("Confirm new password");
});
