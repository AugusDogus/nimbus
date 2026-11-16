/**
 * Layered filename search: the names layer (the whole query in a name) is the
 * instant one; a full search adds the words layer. The compacted names are
 * scanned by search-scan.ts, on this thread or in scan workers; entries added
 * since compaction are matched here, by the same rules.
 *
 * Every layer reads only the ranges the caller may see, so permissions apply
 * before anything is ranked. Results share one order: layer, then the
 * caller's own history, then name length, then tree order. A later layer only
 * adds results below an earlier one's, so a list refined in place never
 * reorders what is already shown.
 *
 * Every rank is distinct, so a page continues from the last rank shown: the
 * next page is the best matches ranked after it, read from the index as it is
 * then. Nothing is stored between pages, and while the layout stays the same
 * no surviving match is repeated or skipped. Compaction renumbers slots; a
 * cursor from before one continues by position instead.
 */
import {
  collector,
  foldQuery,
  MAX_BOOST,
  MAX_TERMS,
  queryTerms,
  Rank,
  scanLayout,
  ScanScratch,
  patternBits,
  termBits,
  TIER_FUZZY_IN_NAME,
  TIER_FUZZY_IN_PATH,
  TIER_WORDS_IN_NAME,
  TIER_WORDS_IN_PATH,
  type CompactRanks,
  type ScanPlan,
  type SearchLayout,
  type VisibleRange,
} from "./search-scan";

export { foldName, foldQuery } from "./search-scan";
export type {
  CompactRanks,
  ScanPlan,
  SearchLayout,
  VisibleRange,
} from "./search-scan";

export type IndexedKind = "file" | "dir";

export type SearchScope =
  | { type: "all" }
  /** Readable subtrees: a path is visible when it is, or is inside, one of these. */
  | { type: "grants"; paths: readonly string[] };

/** One of the caller's own opens, from their bookmarks. */
export type HistoryEntry = {
  path: string;
  /** Milliseconds since the epoch of the latest open. */
  openedAt: number;
  visits: number;
  starred: boolean;
};

/** "instant" runs the names layer only, for results while typing; "full" runs every layer. */
export type SearchDepth = "instant" | "full";

export type SearchRequest = {
  query: string;
  /** Only return entries inside this folder ("" is the drive root). */
  root: string;
  limit: number;
  scope: SearchScope;
  /** Defaults to "instant". */
  depth?: SearchDepth;
  /** Ranks the caller's recent and frequent opens first within each layer. */
  history?: readonly HistoryEntry[];
  /** Continue after the page that returned this `next`. */
  cursor?: string;
};

/**
 * Which layer found a hit: the whole query in its name, its words across name
 * and folders, or words it may have meant (typos and abbreviations).
 */
export type SearchMatch = "name" | "words" | "fuzzy";

export type SearchHit = { path: string; type: IndexedKind; match: SearchMatch };

export type SearchResult = {
  hits: SearchHit[];
  /** More results exist after this page. */
  truncated: boolean;
  /** Matches the layers that ran found: those on earlier pages, this one and after. */
  total: number;
  /** Pass as `cursor` for the next page; null on the last one. */
  next: string | null;
  /** Folded words that matched, for highlighting. Never sent to clients as-is. */
  terms: string[];
};

/** What the query layers need from an index. */
export type IndexView = {
  readonly layout: SearchLayout;
  /** Entries added since the layout was built, with folded names. */
  readonly delta: ReadonlyMap<number, { raw: string; folded: string }>;
  find: (relative: string) => number;
  isLive: (id: number) => boolean;
  isFolder: (id: number) => boolean;
  /** -1 above the root. */
  parentOf: (id: number) => number;
  /** -1 for delta entries. */
  slotOf: (id: number) => number;
  pathOf: (id: number) => string;
  foldedNameOf: (id: number) => string;
  visibleRanges: (rootId: number, granted: number[] | null) => VisibleRange[];
  /** Words in the index a folded query word may have meant, best first. */
  corrections: (term: string) => string[];
};

/**
 * The fuzzy layer runs when the stricter ones found fewer matches than this
 * in the whole result list: typos are worth suggesting when little else is.
 */
export const FUZZY_BELOW = 10;

const NONE = -1;
const ROOT = 0;
const DAY_MS = 86_400_000;

/**
 * 0 for no history, up to 15: recency halves every two weeks, frequency counts
 * logarithmically, and a star is worth a recent open.
 */
export function historyBoost(entry: HistoryEntry, now: number) {
  const age = Math.max(0, now - entry.openedAt) / DAY_MS;
  const score =
    (1 + Math.log2(1 + Math.max(0, entry.visits))) * 0.5 ** (age / 14) +
    (entry.starred ? 1 : 0);
  return Math.min(MAX_BOOST, Math.max(0, Math.round(score * 3)));
}

/** Where a page ended: the layout it was ranked in, its last rank, and how many came before. */
type Cursor = { generation: number; after: number; shown: number };

const Cursor = {
  format: (cursor: Cursor) =>
    `${cursor.generation}-${cursor.after}-${cursor.shown}`,
  /** Null for text that no page returned; such a search starts over. */
  parse(text: string | undefined): Cursor | null {
    const parts = /^(\d{1,15})-(\d{1,16})-(\d{1,9})$/.exec(text ?? "");
    if (!parts) return null;
    return {
      generation: Number(parts[1]),
      after: Number(parts[2]),
      shown: Number(parts[3]),
    };
  },
} as const;

/** Per-index scratch space for scans on this thread, reused while a layout lasts. */
export function createSearchState() {
  let scratch: { layout: SearchLayout; space: ScanScratch } | null = null;
  return {
    scanHere(
      layout: SearchLayout,
      plan: ScanPlan,
      add: (rank: number) => void,
    ) {
      if (scratch?.layout !== layout)
        scratch = { layout, space: ScanScratch.for(layout) };
      scanLayout(layout, plan, scratch.space, add);
    },
  };
}
export type SearchState = ReturnType<typeof createSearchState>;

/** Whether a delta entry is inside the root and the caller's grants. */
function deltaVisible(
  view: IndexView,
  id: number,
  rootId: number,
  grants: Set<number> | null,
) {
  if (id === rootId) return false;
  let inRoot = false;
  let inGrant = grants === null;
  for (let current = id; current !== NONE; current = view.parentOf(current)) {
    if (current === rootId) inRoot = true;
    if (grants?.has(current)) inGrant = true;
  }
  return inRoot && inGrant;
}

/** Both layers over entries added since compaction, by the same rules as search-scan.ts. */
function scanDelta(
  view: IndexView,
  plan: ScanPlan,
  rootId: number,
  grants: Set<number> | null,
  boosts: ReadonlyMap<number, number>,
  add: (rank: number) => void,
) {
  const { needle, terms, fuzzy } = plan;
  const prefixOnly = needle.length === 1;
  const all = (1 << terms.length) - 1;
  const { slots } = view.layout;
  /** Bits of every word in a name and the folders above it. */
  const reach = (
    id: number,
    inName: number,
    full: number,
    bitsOf: (name: string) => number,
  ) => {
    let bits = inName;
    for (
      let parent = view.parentOf(id);
      bits !== full && parent > ROOT;
      parent = view.parentOf(parent)
    )
      bits |= bitsOf(view.foldedNameOf(parent));
    return bits;
  };
  const keep = (rank: number) => {
    if (rank > plan.after) add(rank);
  };
  for (const [id, name] of view.delta) {
    const at = name.folded.indexOf(needle);
    const literal = at >= 0 && (!prefixOnly || at === 0);
    const inName = !literal && terms.length ? termBits(name.folded, terms) : 0;
    if (
      (!literal &&
        inName === 0 &&
        !(fuzzy && patternBits(name.folded, fuzzy))) ||
      !deltaVisible(view, id, rootId, grants)
    )
      continue;
    const boost = boosts.get(id) ?? 0;
    const length = Buffer.byteLength(name.folded);
    if (literal) {
      keep(
        Rank.of(
          Rank.literalTier(
            name.folded.length === needle.length,
            at,
            name.folded.charCodeAt(at - 1),
          ),
          boost,
          length,
          slots + id,
        ),
      );
      continue;
    }
    if (
      inName !== 0 &&
      reach(id, inName, all, (folder) => termBits(folder, terms)) === all
    ) {
      keep(
        Rank.of(
          inName === all ? TIER_WORDS_IN_NAME : TIER_WORDS_IN_PATH,
          boost,
          length,
          slots + id,
        ),
      );
      continue;
    }
    if (!fuzzy) continue;
    const fuzzyAll = (1 << fuzzy.length) - 1;
    const fuzzyInName = patternBits(name.folded, fuzzy);
    if (
      fuzzyInName !== 0 &&
      reach(id, fuzzyInName, fuzzyAll, (folder) =>
        patternBits(folder, fuzzy),
      ) === fuzzyAll
    )
      keep(
        Rank.of(
          fuzzyInName === fuzzyAll ? TIER_FUZZY_IN_NAME : TIER_FUZZY_IN_PATH,
          boost,
          length,
          slots + id,
        ),
      );
  }
}

const empty = (): SearchResult => ({
  hits: [],
  truncated: false,
  total: 0,
  next: null,
  terms: [],
});

/**
 * A search ready for its compacted scan: run `plan` over `layout` keeping the
 * best `limit` ranks, then pass them to `finish`, which matches the entries
 * added since compaction and returns the page, or a second scan when the
 * fuzzy layer should run too.
 */
export type PreparedSearch =
  | { done: SearchResult }
  | {
      done: null;
      layout: SearchLayout;
      plan: ScanPlan;
      limit: number;
      finish: (compacted: CompactRanks) => PreparedSearch;
    };

const matchOf = (rank: number): SearchMatch => {
  const tier = Rank.tier(rank);
  return tier < TIER_WORDS_IN_NAME
    ? "name"
    : tier < TIER_FUZZY_IN_NAME
      ? "words"
      : "fuzzy";
};

export function prepareSearch(
  view: IndexView,
  request: SearchRequest,
): PreparedSearch {
  const { root, limit, scope } = request;
  const needle = foldQuery(request.query);
  const rootId = view.find(root);
  if (!needle || limit <= 0 || rootId === NONE || !view.isFolder(rootId))
    return { done: empty() };
  const granted =
    scope.type === "grants"
      ? scope.paths.map(view.find).filter((id) => id !== NONE)
      : null;
  if (granted?.length === 0) return { done: empty() };
  const full = request.depth === "full";
  const allTerms = queryTerms(needle);
  const usable = allTerms.length <= MAX_TERMS;
  const terms =
    full && usable && !(allTerms.length === 1 && allTerms[0] === needle)
      ? allTerms
      : [];

  const { layout } = view;
  // Within the layout a page was ranked in, continue after its last rank;
  // after a compaction, by position.
  const cursor = Cursor.parse(request.cursor);
  const continues = cursor !== null && cursor.generation === layout.generation;
  const skip = cursor && !continues ? cursor.shown : 0;
  const shown = cursor?.shown ?? 0;

  const boosts: number[] = [];
  const deltaBoosts = new Map<number, number>();
  const now = Date.now();
  for (const entry of request.history ?? []) {
    const id = view.find(entry.path);
    if (id === NONE) continue;
    const boost = historyBoost(entry, now);
    const slot = view.slotOf(id);
    if (slot === NONE) deltaBoosts.set(id, boost);
    else boosts.push(slot, boost);
  }
  const strict: ScanPlan = {
    needle,
    terms,
    fuzzy: null,
    ranges: view.visibleRanges(rootId, granted),
    boosts,
    after: continues ? cursor.after : -1,
  };
  const grants = granted ? new Set(granted) : null;
  const want = skip + limit;

  const step = (plan: ScanPlan): PreparedSearch => ({
    done: null,
    layout,
    plan,
    limit: want,
    finish: (compacted) => {
      const results = collector(want);
      results.merge(compacted);
      scanDelta(view, plan, rootId, grants, deltaBoosts, (rank) =>
        results.add(rank),
      );
      // Too little found: run again with the words the query may have meant.
      // Pages before this one count, so every page of a search decides alike.
      if (plan.fuzzy === null && full && usable && allTerms.length) {
        const strictTotal = continues ? shown + results.total : results.total;
        if (strictTotal < FUZZY_BELOW) {
          const fuzzy = allTerms.map((term) => [
            term,
            ...view.corrections(term),
          ]);
          if (fuzzy.some((patterns) => patterns.length > 1))
            return step({ ...plan, fuzzy });
        }
      }
      const best = results.best();
      const hits: SearchHit[] = [];
      let last = -1;
      for (let at = skip; at < best.length; at++) {
        const rank = best[at] ?? 0;
        const order = Rank.order(rank);
        const id =
          order < layout.slots
            ? (layout.slotId[order] ?? NONE)
            : order - layout.slots;
        last = rank;
        hits.push({
          path: view.pathOf(id),
          type: view.isFolder(id) ? "dir" : "file",
          match: matchOf(rank),
        });
      }
      const more = results.total > want;
      return {
        done: {
          hits,
          truncated: more,
          total: (continues ? shown : 0) + results.total,
          next: more
            ? Cursor.format({
                generation: layout.generation,
                after: last,
                shown: shown + hits.length,
              })
            : null,
          terms: plan.fuzzy
            ? [...new Set(plan.fuzzy.flat())]
            : terms.length
              ? terms
              : [needle],
        },
      };
    },
  });
  return step(strict);
}

/** Scan the compacted names on this thread. */
export function scanCompacted(
  state: SearchState,
  layout: SearchLayout,
  plan: ScanPlan,
  limit: number,
): CompactRanks {
  const results = collector(limit);
  state.scanHere(layout, plan, (rank) => results.add(rank));
  return { best: results.best(), total: results.total };
}

/** A whole search on this thread. */
export function runSearch(
  view: IndexView,
  state: SearchState,
  request: SearchRequest,
): SearchResult {
  let prepared = prepareSearch(view, request);
  while (!prepared.done)
    prepared = prepared.finish(
      scanCompacted(state, prepared.layout, prepared.plan, prepared.limit),
    );
  return prepared.done;
}
