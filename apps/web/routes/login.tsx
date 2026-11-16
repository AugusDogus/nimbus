import { createFileRoute } from "@tanstack/react-router";
import { AuthPage } from "@/app/auth/auth-page";
import { LoginForm } from "@/components/login-form";
import { CallbackUrl } from "@/lib/callback-url";
import { trpc } from "@/lib/trpc";
import { SearchParams } from "@/client/search-params";

/** Messages for errors that single sign-on returns to this page as `?error=`. */
function providerError(code: string | undefined, provider: string) {
  if (!code) return null;
  switch (code) {
    case "account_not_linked":
    case "signup_disabled":
    case "unable_to_create_user":
      return `No Nimbus account uses the email address from ${provider}. Ask your server administrator to create one with that address, then try again.`;
    case "email_not_verified":
      return `${provider} has not verified your email address, so Nimbus cannot match it to an account. Verify it with ${provider} and try again.`;
    case "banned":
      return "This account is disabled. Ask your server administrator to enable it.";
    default:
      return `Signing in with ${provider} did not finish. Try again, or sign in with your password.`;
  }
}

export const Route = createFileRoute("/login")({
  validateSearch: (search): { error?: string; callbackURL?: string } => ({
    error: SearchParams.string(search, "error"),
    callbackURL: SearchParams.string(search, "callbackURL"),
  }),
  loader: ({ context }) =>
    context.queryClient.fetchQuery(trpc.signIn.options.queryOptions()),
  component: LoginPage,
});

function LoginPage() {
  const options = Route.useLoaderData();
  const { error, callbackURL } = Route.useSearch();
  return (
    <AuthPage>
      <LoginForm
        setupAvailable={options.setupAvailable}
        singleSignOn={options.singleSignOn}
        passwordReset={options.passwordReset}
        initialError={providerError(
          error,
          options.singleSignOn ?? "your identity provider",
        )}
        redirectTo={CallbackUrl.parse(callbackURL)}
      />
    </AuthPage>
  );
}
