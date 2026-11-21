/** What decides where an account starts: the `access.me` answer, or the part of it needed. */
type Account = { isAdmin: boolean; home: string | null; top: string };

/**
 * Where an account starts. Signing in without a destination goes to `PATH`, which opens the drive
 * root for administrators and the home folder for everyone else. Files, at `/`, opens the
 * account's top folder: the root, or the home for an account that reaches nothing outside it.
 * Folders are relative to the drive root; "" is the root.
 */
export const Landing = {
  PATH: "/start",
  /** The folder signing in opens. */
  afterSignIn: (account: Account) =>
    account.isAdmin || account.home === null ? "" : account.home,
  /** The folder `/` opens instead of the root, or null when it opens the root. */
  rootRedirect: (account: Account) => (account.top === "" ? null : account.top),
} as const;
