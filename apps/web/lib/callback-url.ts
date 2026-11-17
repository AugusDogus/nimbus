const DEFAULT = "/";
const MAX_LENGTH = 2048;
const PROBE_ORIGIN = "https://callback.invalid";

/**
 * Where to go after signing in. Only same-origin relative paths are accepted
 * (such as "/oauth/consent?..."); anything that could leave the site
 * ("https://...", "//host", "/\host", control characters) falls back to "/".
 */
export const CallbackUrl = {
  DEFAULT,
  parse(value: unknown): string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_LENGTH
    )
      return DEFAULT;
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      value.includes("\\")
    )
      return DEFAULT;
    if (/[\x00-\x20\x7f]/.test(value) || !URL.canParse(value, PROBE_ORIGIN))
      return DEFAULT;
    return new URL(value, PROBE_ORIGIN).origin === PROBE_ORIGIN
      ? value
      : DEFAULT;
  },
  /** The sign-in page that returns to `target`, a path on this site, once signed in. */
  signInPath(target: string): string {
    const callback = CallbackUrl.parse(target);
    return callback === DEFAULT
      ? "/login"
      : `/login?${new URLSearchParams({ callbackURL: callback })}`;
  },
} as const;
