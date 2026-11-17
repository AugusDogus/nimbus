import { CallbackUrl } from "@/lib/callback-url";

/** What the sign-in page offers, as the server's `signIn.options` procedure reports it. */
export type SignInOptions = {
  setupAvailable: boolean;
  /** Label of the configured identity provider, or null when single sign-on is off. */
  singleSignOn: string | null;
  /** Whether forgotten passwords can be reset by email. */
  passwordReset: boolean;
};

/**
 * What the server sends with a sign-in, sign-up or password reset page. The server decides it
 * once from the request; the browser hydrates the same page from it.
 */
export type AuthPageData =
  | {
      page: "sign-in";
      options: SignInOptions;
      /** A message for an error single sign-on returned with, or null. */
      error: string | null;
      /** A validated same-origin path to open after signing in. */
      redirectTo: string;
    }
  | { page: "sign-up" }
  | { page: "reset-password"; token: string | null; expired: boolean };

/** Messages for errors that single sign-on returns to the sign-in page as `?error=`. */
function providerError(code: string | null, provider: string) {
  if (!code) return null;
  switch (code) {
    case "account_not_linked":
    case "signup_disabled":
    case "unable_to_create_user":
      return `No Nimbus account uses the email address from ${provider}. Ask your server administrator to create one with that address, then try again.`;
    case "email_not_verified":
      return `${provider} has not verified your email address, so Nimbus cannot match it to an account. Verify it with ${provider} and try again.`;
    case "administrator_required":
      return "This Nimbus server has no administrator yet. Create the administrator account with a password first, then use single sign-on.";
    case "banned":
      return "This account is disabled. Ask your server administrator to enable it.";
    default:
      return `Signing in with ${provider} did not finish. Try again, or sign in with your password.`;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

function parseOptions(value: unknown): SignInOptions | undefined {
  if (
    !isRecord(value) ||
    typeof value.setupAvailable !== "boolean" ||
    typeof value.passwordReset !== "boolean" ||
    !nullableString(value.singleSignOn)
  )
    return undefined;
  return {
    setupAvailable: value.setupAvailable,
    singleSignOn: value.singleSignOn,
    passwordReset: value.passwordReset,
  };
}

export const AuthPageData = {
  /** The sign-in page for `search`: `error` from single sign-on and `callbackURL`. */
  signIn(options: SignInOptions, search: URLSearchParams): AuthPageData {
    return {
      page: "sign-in",
      options,
      error: providerError(
        search.get("error"),
        options.singleSignOn ?? "your identity provider",
      ),
      redirectTo: CallbackUrl.parse(search.get("callbackURL")),
    };
  },

  /** The password reset page for `search`: the emailed `token`, or `error` for a stale one. */
  resetPassword(search: URLSearchParams): AuthPageData {
    return {
      page: "reset-password",
      token: search.get("token"),
      expired: search.get("error") === "INVALID_TOKEN",
    };
  },

  parse(value: unknown): AuthPageData | undefined {
    if (!isRecord(value)) return undefined;
    switch (value.page) {
      case "sign-in": {
        const options = parseOptions(value.options);
        const { error, redirectTo } = value;
        return options &&
          nullableString(error) &&
          typeof redirectTo === "string"
          ? {
              page: "sign-in",
              options,
              error,
              // Checked again, so the page never sends anyone off the site.
              redirectTo: CallbackUrl.parse(redirectTo),
            }
          : undefined;
      }
      case "sign-up":
        return { page: "sign-up" };
      case "reset-password": {
        const { token, expired } = value;
        return nullableString(token) && typeof expired === "boolean"
          ? { page: "reset-password", token, expired }
          : undefined;
      }
      default:
        return undefined;
    }
  },
} as const;
