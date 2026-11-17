import { plain, plainWithPositions } from "./search-text";

/** Half-open [start, end) offsets into a displayed string, sorted and disjoint. */
export type HighlightRanges = [number, number][];

/** Where a search hit matched: in its name, and in the folder path shown beside it. */
export type SearchHighlight = {
  name: HighlightRanges;
  folder: HighlightRanges;
};

/**
 * Each folded term's occurrences in `text`, as offsets into `text` itself,
 * found without accents (search-text.ts) so a match typed without them is
 * marked on the accented letters. Single characters match only at the start
 * of `text` or after a "/", as they do in search. Text that is not NFC gets
 * no ranges rather than misplaced ones.
 */
function rangesIn(text: string, terms: readonly string[]): HighlightRanges {
  const read = plainWithPositions(text);
  if (!read) return [];
  const found: HighlightRanges = [];
  for (const typed of terms) {
    const term = plain(typed);
    if (!term) continue;
    for (
      let at = read.plain.indexOf(term);
      at >= 0;
      at = read.plain.indexOf(term, at + term.length)
    )
      if (term.length > 1 || at === 0 || read.plain[at - 1] === "/")
        found.push([
          read.from[at] ?? 0,
          read.to[at + term.length - 1] ?? text.length,
        ]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: HighlightRanges = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** Highlights for a hit at `path`; the folder part is the path before its name. */
function forPath(path: string, terms: readonly string[]): SearchHighlight {
  const slash = path.lastIndexOf("/");
  return {
    name: rangesIn(path.slice(slash + 1), terms),
    folder: slash < 0 ? [] : rangesIn(path.slice(0, slash), terms),
  };
}

export const SearchHighlight = { forPath } as const;
