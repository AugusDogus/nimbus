/**
 * Code loaded on demand, such as a dialog, a preview or a page, and what a failed load means.
 *
 * Nimbus ships each build with new file names. A page opened before a deployment still asks for
 * the old ones, which the server no longer has, so only reloading gets the new code. Other loads
 * fail for a while, such as on a dropped connection, and pass when tried again. Once Nimbus was
 * updated, the next move to another page loads that page in full (see `reloadForUpdate`), unless
 * leaving would lose an upload, a transfer or unsaved text (see `LeaveGuard`).
 */

import { LeaveGuard } from "./leave-guard";

/**
 * `updated`: a deployment replaced the files of the build this page runs. `unavailable`: loading
 * kept failing, though the files may still be there, such as while offline. Either way only a
 * reload helps: the browser keeps the failure of a file a failed load imported, and never asks
 * for it again.
 */
export type CodeLoadFailure = "updated" | "unavailable";

const messages: Record<CodeLoadFailure, string> = {
  updated: "Nimbus has been updated.",
  unavailable: "Part of Nimbus could not load.",
};

export class CodeLoadError extends Error {
  readonly kind: CodeLoadFailure;
  constructor(kind: CodeLoadFailure, cause: unknown) {
    super(messages[kind], { cause });
    this.name = "CodeLoadError";
    this.kind = kind;
  }
}

/** What the notice shows, if anything. */
export type CodeLoadNotice = CodeLoadFailure | null;

declare global {
  /**
   * The address a built chunk's `import()` asks for (see vite/fresh-chunk-imports.ts): the
   * chunk's own, or one with a query after it failed, since browsers keep a failed module's
   * failure for its address and would never ask for it again.
   */
  var nimbusChunkUrl: ((specifier: string) => string) | undefined;
}

/** Each built file whose load failed, by name, with the query its next request carries. */
const fresh = new Map<string, string>();
/** Numbers those queries, so no request repeats an address that failed before. */
let tries = 0;
globalThis.nimbusChunkUrl = (specifier) =>
  specifier +
  (fresh.get(specifier.slice(specifier.lastIndexOf("/") + 1)) ?? "");

/** The built file a failed `import()` names, when the browser names it (Chromium and Firefox do). */
function failedFile(error: unknown) {
  const named =
    error instanceof Error
      ? /https?:\/\/\S+?\.(?:js|css)\b/.exec(error.message)?.[0]
      : undefined;
  if (!named) return undefined;
  const url = new URL(named);
  return url.origin === location.origin && url.pathname.startsWith("/assets/")
    ? url
    : undefined;
}

/**
 * Whether the build this page runs is gone: the server answers 404 for the file that failed, or
 * for the page's own entry, which a deployment replaces. Throws when the server is unreachable.
 */
async function replaced(file: URL | undefined) {
  for (const url of [file?.pathname, entryPath()])
    if (
      url &&
      (await fetch(url, { method: "HEAD", cache: "no-store" })).status === 404
    )
      return true;
  return false;
}

/** The path of this page's own entry script, which a deployment replaces. */
function entryPath() {
  const src = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src]',
  )?.src;
  return src ? new URL(src).pathname : undefined;
}

/** Whether a deployment replaced this page's build; nothing says so until something fails. */
let updated = false;
let notice: CodeLoadNotice = null;
/** Whether the page is reloading to run the new build. */
let reloading = false;
const watchers = new Set<() => void>();

function show(next: CodeLoadNotice) {
  notice = next;
  for (const watcher of watchers) watcher();
}

/** Builds that answers named, other than this page's, whose entry was checked already. */
const checkedBuilds = new Set<string>();

/**
 * The build whose page last reloaded for an update, in this tab. A reload that lands on that same
 * build, such as from a cache that still serves its page, reloads no more.
 */
const reloadedFrom = "nimbus:update-reloaded-from";

/**
 * Reloads the page, once Nimbus was updated, to run the new build, unless leaving would lose
 * work, or the page already reloaded from this build. The router calls it when it moves to
 * another page, with `showAddress` to put that page's address in place first, so the reload opens
 * that page. Says whether the page is reloading.
 */
function reloadForUpdate(showAddress?: () => void) {
  if (reloading) return true;
  const entry = entryPath();
  if (!updated || !entry || LeaveGuard.busy()) return false;
  try {
    if (sessionStorage.getItem(reloadedFrom) === entry) return false;
    sessionStorage.setItem(reloadedFrom, entry);
  } catch {
    // Without a record of the reload, a reload could follow another.
    return false;
  }
  reloading = true;
  showAddress?.();
  location.reload();
  return true;
}

/** Never settles: what waits on it waits for the page to unload. */
const unloading = new Promise<void>(() => undefined);

/** The pauses before trying a failed load again: three tries at most, further apart each time. */
const delays = [1000, 3000];

/**
 * `importer`, tried again after a failure that may pass, each time with a new request. Fails
 * with a `CodeLoadError` saying which kind of failure it was, never with the browser's own
 * error, which TanStack Router answers by reloading the page. Notes when Nimbus was updated.
 * Once it was, a load fails at the first failure: code this page loaded already still loads,
 * and the browser does not ask again for a file that failed.
 */
async function load<T>(importer: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await importer();
    } catch (error) {
      if (typeof document === "undefined") throw error;
      if (updated) throw new CodeLoadError("updated", error);
      const file = failedFile(error);
      if (await replaced(file).catch(() => false)) {
        updated = true;
        throw new CodeLoadError("updated", error);
      }
      const delay = delays[attempt];
      if (delay === undefined) throw new CodeLoadError("unavailable", error);
      if (file) fresh.set(file.pathname.slice(8), `?retry=${++tries}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export const CodeLoad = {
  load,
  message: (kind: CodeLoadFailure) => messages[kind],

  /**
   * Shows that code something asked for did not load, and why, with Reload. Each failure shows
   * it again, also after it was dismissed.
   */
  failed(error: unknown) {
    show(
      updated || (error instanceof CodeLoadError && error.kind === "updated")
        ? "updated"
        : "unavailable",
    );
  },

  reloadForUpdate,
  /** For the router to wait on while the page reloads, so the page stays as it is meanwhile. */
  reloading: () => (reloading ? unloading : undefined),

  /**
   * Compares the build the server runs, as its answers name it, with this page's. Another name is
   * only a hint, since an older server or a cached answer can carry one: Nimbus was updated only
   * when this page's own entry is gone. Each name is checked once.
   */
  checkBuild(build: string | null) {
    const entry = entryPath();
    if (
      !build ||
      !entry ||
      updated ||
      checkedBuilds.has(build) ||
      entry === build
    )
      return;
    checkedBuilds.add(build);
    void fetch(entry, { method: "HEAD", cache: "no-store" }).then(
      (response) => {
        if (response.status === 404) updated = true;
      },
      () => undefined,
    );
  },

  notice: (): CodeLoadNotice => notice,
  watch(watcher: () => void) {
    watchers.add(watcher);
    return () => void watchers.delete(watcher);
  },
  dismiss: () => show(null),
} as const;
