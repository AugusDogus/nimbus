import { CallbackUrl } from "@/lib/callback-url";

/**
 * The sign-in page that returns to `target`, a path on this site, once signed in. The bare `/`
 * names no folder, so signing in from it lands where any account starts.
 */
export function signInPath(target: string): string {
  const callback = CallbackUrl.parse(target);
  return callback === CallbackUrl.DEFAULT || callback === "/"
    ? "/login"
    : `/login?${new URLSearchParams({ callbackURL: callback })}`;
}
