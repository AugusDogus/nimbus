/** What paging needs of a `catalog.search` page. */
export type PageLike<E extends { path: string }> = {
  entries: readonly E[];
  /** Continues after this page, or null at the end. */
  next: string | null;
  /**
   * The previous page could not be continued, so this is page one of the search as it stands
   * now: it replaces what was shown, and paging goes on from it.
   */
  restarted: boolean;
};

/**
 * The pages shown after the first page, which React Query holds. `head`, when set, is a fresh
 * page one that replaced the first page after a restart.
 */
export type LaterPages<P> = { head: P | null; pages: P[] };

const none: LaterPages<never> = { head: null, pages: [] };

/** The pages on screen, in order. */
function shown<P>(first: P, later: LaterPages<P>): P[] {
  return [later.head ?? first, ...later.pages];
}

/** The entries of `pages` in order, each path once. */
function entries<E extends { path: string }>(
  pages: readonly PageLike<E>[],
): E[] {
  const seen = new Set<string>();
  const result: E[] = [];
  for (const page of pages)
    for (const entry of page.entries)
      if (!seen.has(entry.path)) {
        seen.add(entry.path);
        result.push(entry);
      }
  return result;
}

/**
 * Fetches pages after those shown until `wanted` pages are shown or the results end. A
 * restarted page replaces everything shown and paging goes on from it, so the user keeps about
 * as many results as they had asked for; a second restart stops there rather than loop.
 * Returns the new pages without changing anything, so the caller swaps them in at once.
 */
async function fill<E extends { path: string }, P extends PageLike<E>>(
  first: P,
  later: LaterPages<P>,
  wanted: number,
  fetchAfter: (cursor: string) => Promise<P>,
): Promise<LaterPages<P> & { restarted: boolean }> {
  let head = later.head;
  let pages = [...later.pages];
  let restarted = false;
  let last = pages.at(-1) ?? head ?? first;
  while (1 + pages.length < wanted && last.next !== null) {
    const page = await fetchAfter(last.next);
    if (page.restarted) {
      const again = restarted;
      restarted = true;
      head = page;
      pages = [];
      last = page;
      if (again) break;
      continue;
    }
    pages.push(page);
    last = page;
  }
  return { head, pages, restarted };
}

export const SearchPages = { none, shown, entries, fill } as const;
