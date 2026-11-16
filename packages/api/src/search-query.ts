/**
 * Layered filename search: the names layer (the whole query in a name) is the
 * instant one; a full search adds the words layer (see search-scan.ts) and
 * keeps its ranked list for paging. The compacted names are scanned by
 * search-scan.ts; entries added since compaction are matched here, by the
 * same rules.
 *
 * Every layer reads only the ranges the caller may see, so permissions apply
 * before anything is ranked. Results share one order: layer, then the
 * caller's own history, then name length, then tree order. A later layer only
 * adds results below an earlier one's, so a list refined in place never
 * reorders what is already shown.
 */
import {
  foldQuery,
  MAX_BOOST,
  MAX_TERMS,
  queryTerms,
  Rank,
  scanLayout,
  ScanScratch,
  termBits,
  TIER_WORDS_IN_NAME,
  TIER_WORDS_IN_PATH,
  type ScanPlan,
  type SearchLayout,
  type VisibleRange,
} from "./search-scan";

export { foldName, foldQuery } from "./search-scan";
export type { SearchLayout, VisibleRange } from "./search-scan";

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

/**
 * "instant" runs the name layer only, for results while typing. "full" runs
 * every layer and keeps the ranked list so later pages can be read from it.
 */
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
  /** Position in the ranked list to start from, as `next` returned it. */
  offset?: number;
};

/** Which layer found a hit: the whole query in its name, or its words across name and folders. */
export type SearchMatch = "name" | "words";

export type SearchHit = { path: string; type: IndexedKind; match: SearchMatch };

export type SearchResult = {
  hits: SearchHit[];
  /** More results exist after this page. */
  truncated: boolean;
  /** Every match the layers that ran found, before this page was cut. */
  total: number;
  /** The offset of the next page, or null on the last one. */
  next: number | null;
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
};

/**
 * Runs the compacted part of a search. The default scans on this thread; a
 * pool of scan workers can take over for large layouts.
 */
export type LayoutScanner = (
  layout: SearchLayout,
  plan: ScanPlan,
  add: (rank: number) => void,
) => void;

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

/** The best `limit` ranks, sorted, plus every rank when the full list is kept. */
function collector(limit: number, keepAll: boolean) {
  const best = new Float64Array(limit);
  let kept = 0;
  let total = 0;
  let all = keepAll ? new Float64Array(1024) : null;
  return {
    add(rank: number) {
      if (all) {
        if (total === all.length) {
          const grown = new Float64Array(all.length * 2);
          grown.set(all);
          all = grown;
        }
        all[total] = rank;
      }
      total++;
      if (kept === limit && rank >= (best[limit - 1] ?? 0)) return;
      let index = kept < limit ? kept++ : limit - 1;
      while (index > 0 && (best[index - 1] ?? 0) > rank) {
        best[index] = best[index - 1] ?? 0;
        index--;
      }
      best[index] = rank;
    },
    get total() {
      return total;
    },
    best: () => best.subarray(0, kept),
    all: () => all?.subarray(0, total) ?? null,
  };
}

/** A ranked list kept for paging, with the layout its slot orders refer to. */
type Session = { ranks: Float64Array; sorted: boolean; layout: SearchLayout };

const MAX_SESSIONS = 8;
const MAX_SESSION_RANKS = 8_000_000;

/** Per-index state the query layers keep between searches. */
export function createSearchState() {
  let scratch: { layout: SearchLayout; space: ScanScratch } | null = null;
  const sessions = new Map<string, Session>();
  return {
    /** Scans on this thread, reusing scratch space while the layout lasts. */
    scanHere: ((layout, plan, add) => {
      if (scratch?.layout !== layout)
        scratch = { layout, space: ScanScratch.for(layout) };
      scanLayout(layout, plan, scratch.space, add);
    }) satisfies LayoutScanner,
    session(key: string) {
      const found = sessions.get(key);
      if (found) {
        sessions.delete(key);
        sessions.set(key, found);
      }
      return found ?? null;
    },
    keep(key: string, session: Session) {
      sessions.delete(key);
      sessions.set(key, session);
      let ranks = 0;
      for (const kept of sessions.values()) ranks += kept.ranks.length;
      for (const [oldest, kept] of sessions) {
        if (sessions.size <= MAX_SESSIONS && ranks <= MAX_SESSION_RANKS) break;
        if (oldest === key) break;
        sessions.delete(oldest);
        ranks -= kept.ranks.length;
      }
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
  const { needle, terms } = plan;
  const prefixOnly = needle.length === 1;
  const all = (1 << terms.length) - 1;
  const { slots } = view.layout;
  for (const [id, name] of view.delta) {
    const at = name.folded.indexOf(needle);
    const literal = at >= 0 && (!prefixOnly || at === 0);
    const inName = !literal && terms.length ? termBits(name.folded, terms) : 0;
    if ((!literal && inName === 0) || !deltaVisible(view, id, rootId, grants))
      continue;
    const boost = boosts.get(id) ?? 0;
    const length = Buffer.byteLength(name.folded);
    if (literal) {
      add(
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
    let bits = inName;
    for (
      let parent = view.parentOf(id);
      bits !== all && parent > ROOT;
      parent = view.parentOf(parent)
    )
      bits |= termBits(view.foldedNameOf(parent), terms);
    if (bits === all)
      add(
        Rank.of(
          inName === all ? TIER_WORDS_IN_NAME : TIER_WORDS_IN_PATH,
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

/** Hits for ranks, skipping entries removed since they were ranked. */
function hitsFor(
  view: IndexView,
  layout: SearchLayout,
  ranks: Float64Array,
  from: number,
  limit: number,
) {
  const hits: SearchHit[] = [];
  let at = from;
  for (; at < ranks.length && hits.length < limit; at++) {
    const rank = ranks[at] ?? 0;
    const order = Rank.order(rank);
    const id =
      order < layout.slots
        ? (layout.slotId[order] ?? NONE)
        : order - layout.slots;
    if (!view.isLive(id)) continue;
    hits.push({
      path: view.pathOf(id),
      type: view.isFolder(id) ? "dir" : "file",
      match: Rank.tier(rank) < TIER_WORDS_IN_NAME ? "name" : "words",
    });
  }
  return { hits, next: at < ranks.length ? at : null };
}

export function runSearch(
  view: IndexView,
  state: SearchState,
  request: SearchRequest,
  scanner: LayoutScanner = state.scanHere,
): SearchResult {
  const { root, limit, scope } = request;
  const needle = foldQuery(request.query);
  const rootId = view.find(root);
  if (!needle || limit <= 0 || rootId === NONE || !view.isFolder(rootId))
    return empty();
  const granted =
    scope.type === "grants"
      ? scope.paths.map(view.find).filter((id) => id !== NONE)
      : null;
  if (granted?.length === 0) return empty();
  const depth = request.depth ?? "instant";
  const offset = Math.max(0, Math.floor(request.offset ?? 0));
  const allTerms = queryTerms(needle);
  const terms =
    depth === "full" &&
    allTerms.length <= MAX_TERMS &&
    !(allTerms.length === 1 && allTerms[0] === needle)
      ? allTerms
      : [];
  const matchedTerms = terms.length ? terms : [needle];

  // Full searches keep their ranked list, so the next page reads the same order.
  const key =
    depth === "full"
      ? JSON.stringify([needle, root, scope, request.history ?? []])
      : null;
  const kept = key && offset > 0 ? state.session(key) : null;
  if (kept) {
    if (!kept.sorted) {
      kept.ranks.sort();
      kept.sorted = true;
    }
    const page = hitsFor(view, kept.layout, kept.ranks, offset, limit);
    return {
      ...page,
      truncated: page.next !== null,
      total: kept.ranks.length,
      terms: matchedTerms,
    };
  }

  const { layout } = view;
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
  const plan: ScanPlan = {
    needle,
    terms,
    ranges: view.visibleRanges(rootId, granted),
    boosts,
  };
  const results = collector(offset + limit, key !== null);
  const add = (rank: number) => results.add(rank);
  scanner(layout, plan, add);
  scanDelta(
    view,
    plan,
    rootId,
    granted ? new Set(granted) : null,
    deltaBoosts,
    add,
  );

  const ranked = results.all();
  if (key && ranked && results.total > offset + limit)
    state.keep(key, { ranks: ranked, sorted: false, layout });
  const page = hitsFor(view, layout, results.best(), offset, limit);
  return {
    hits: page.hits,
    truncated: results.total > offset + page.hits.length,
    total: results.total,
    next: results.total > offset + limit ? offset + limit : null,
    terms: matchedTerms,
  };
}
