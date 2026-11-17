import { CallbackUrl } from "@/lib/callback-url";

/** The sign-in page that returns to `target`, a path on this site, once signed in. */
export function signInPath(target: string): string {
  const callback = CallbackUrl.parse(target);
  return callback === CallbackUrl.DEFAULT
    ? "/login"
    : `/login?${new URLSearchParams({ callbackURL: callback })}`;
}
