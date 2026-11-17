import { LoginForm } from "@/components/login-form";
import { SignupForm } from "@/components/signup-form";
import type { AuthPageData } from "./auth-page-data";
import { AuthPage } from "./auth-page";
import { ResetPasswordForm } from "./reset-password-form";

/** The sign-in, sign-up or password reset page, as the server renders and the browser hydrates. */
export function AuthScreen({ data }: { data: AuthPageData }) {
  return <AuthPage>{content(data)}</AuthPage>;
}

function content(data: AuthPageData) {
  switch (data.page) {
    case "sign-in":
      return (
        <LoginForm
          setupAvailable={data.options.setupAvailable}
          singleSignOn={data.options.singleSignOn}
          passwordReset={data.options.passwordReset}
          initialError={data.error}
          redirectTo={data.redirectTo}
        />
      );
    case "sign-up":
      return <SignupForm />;
    case "reset-password":
      return <ResetPasswordForm token={data.token} expired={data.expired} />;
  }
}
