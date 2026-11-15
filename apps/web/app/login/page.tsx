import { db } from "@/server/db";
import { user } from "@/server/db/schema";
import { mailConfig } from "@/server/mail";
import { oidcConfig } from "@/lib/oidc-config";
import { connection } from "next/server";

import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import Link from "next/link";

import { LoginForm } from "@/components/login-form";

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

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const [existing] = await db.select({ id: user.id }).from(user).limit(1);
  const { error } = await searchParams;
  const provider = oidcConfig.kind === "oidc" ? oidcConfig.label : null;
  return (
    <div className="bg-muted flex min-h-dvh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link
          href="/"
          className="flex items-center gap-2 self-center font-medium"
        >
          <NimbusLogo className="size-8" />
          <NimbusWordmark />
        </Link>
        <LoginForm
          setupAvailable={!existing}
          singleSignOn={provider}
          passwordReset={mailConfig.kind === "smtp"}
          initialError={providerError(
            typeof error === "string" ? error : undefined,
            provider ?? "your identity provider",
          )}
        />
      </div>
    </div>
  );
}
