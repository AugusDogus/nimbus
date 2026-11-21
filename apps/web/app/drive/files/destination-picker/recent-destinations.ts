/**
 * Folders this browser recently moved or copied items into, newest first, per account.
 *
 * Kept in the browser rather than the database: recording one costs no request and no write
 * commit on the transfer path, nothing has to follow folders that are moved or deleted later
 * (a stale entry just fails its capability check when opened, and is dropped), and nothing
 * needs pruning on the server. The cost is that the list does not follow the account to
 * another browser, which suits a short list of shortcuts.
 */

/** Paths kept per account. */
export const RECENT_LIMIT = 8;

/** What the list is read from and written to; `localStorage` in the app, a map in tests. */
export type RecentStorage = Pick<Storage, "getItem" | "setItem">;

const keyFor = (account: string) => `nimbus:recent-destinations:${account}`;

const browserStorage = (): RecentStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Storage can be refused outright, as in some private windows.
    return null;
  }
};

/** The stored paths, or none when nothing valid is stored or storage is unavailable. */
function list(
  account: string,
  storage: RecentStorage | null = browserStorage(),
): string[] {
  let stored: unknown;
  try {
    stored = JSON.parse(storage?.getItem(keyFor(account)) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((item): item is string => typeof item === "string")
    .slice(0, RECENT_LIMIT);
}

function write(
  account: string,
  paths: readonly string[],
  storage: RecentStorage | null,
) {
  try {
    storage?.setItem(keyFor(account), JSON.stringify(paths));
  } catch {
    // A full or refused storage keeps the previous list; the transfer itself succeeded.
  }
}

/** Put `path` first, keeping at most `RECENT_LIMIT`. */
function record(
  account: string,
  path: string,
  storage: RecentStorage | null = browserStorage(),
) {
  write(
    account,
    [path, ...list(account, storage).filter((item) => item !== path)].slice(
      0,
      RECENT_LIMIT,
    ),
    storage,
  );
}

/** Drop `path`, such as a folder that no longer exists. */
function forget(
  account: string,
  path: string,
  storage: RecentStorage | null = browserStorage(),
) {
  write(
    account,
    list(account, storage).filter((item) => item !== path),
    storage,
  );
}

export const RecentDestinations = { list, record, forget } as const;
