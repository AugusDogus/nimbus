/**
 * Layered filename search over a search index's layout.
 *
 * - Names: the whole query as a substring of a name, ranked exact, prefix,
 *   word boundary, then anywhere. One native scan per visible range; this is
 *   the instant layer, and what search did before layers existed.
 * - Words: every word of the query in the name or in a folder above it, at
 *   least one in the name. One scan per word marks the slots whose names hold
 *   it; a candidate's folders are checked through those marks by walking up
 *   the tree, so full paths are never built.
 *
 * Every layer reads only the ranges the caller may see, so permissions apply
 * before anything is ranked. Results share one order: layer, then the
 * caller's own history, then name length, then tree order. A later layer only
 * adds results below an earlier one's, so a list refined in place never
 * reorders what is already shown.
 */

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

/** The compacted part of an index, replaced (never changed) by compaction. */
export type SearchLayout = {
  /** Folded names as UTF-8, each preceded by a NUL, in depth-first order. */
  readonly folded: Buffer;
  /** Byte offset of each slot's name in `folded`; one extra entry ends the last. */
  readonly foldedStarts: Int32Array;
  readonly slotId: Int32Array;
  /** The slot after each slot's subtree. */
  readonly subtreeEnd: Int32Array;
  readonly slots: number;
};

/** A slot range a caller may see, and the nearest folder above it outside the range. */
export type VisibleRange = { first: number; end: number; outside: number };

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

const NONE = -1;
const ROOT = 0;
const SEPARATOR = "\0";

const boundary = new Uint8Array(128);
for (const char of " _-.()[]+,@#&'") boundary[char.charCodeAt(0)] = 1;

/** NFC plus lowercase: what both names and queries are compared as. */
export const foldName = (value: string) => value.normalize("NFC").toLowerCase();

/** Queries are typed text; control characters can never match a name. */
export const foldQuery = (value: string) =>
  foldName(value.trim()).replace(/[\u0000-\u001f\u007f]/g, "");

/** Words of a folded query, split at spaces and "/", without bare punctuation. */
export function queryTerms(needle: string) {
  const terms: string[] = [];
  for (const part of needle.split(/[\s/]+/u))
    if (/[\p{L}\p{N}]/u.test(part) && !terms.includes(part)) terms.push(part);
  return terms;
}

/** Words beyond this many run the name layer only: one mask byte holds them. */
const MAX_TERMS = 7;
const LITERAL = 0x80;

// Rank: layer tier, then history boost, then name length, then tree order.
// Smaller is better; every part fits a float64 exactly (5 + 4 + 12 + 32 bits).
const TIER = 2 ** 48;
const BOOST = 2 ** 44;
const LENGTH = 2 ** 32;
const MAX_BOOST = 15;
const tierOf = (rank: number) => Math.floor(rank / TIER);
const orderOf = (rank: number) => rank % LENGTH;
const rankOf = (tier: number, boost: number, length: number, order: number) =>
  tier * TIER +
  (MAX_BOOST - boost) * BOOST +
  Math.min(length, 4095) * LENGTH +
  order;

const TIER_WORDS_IN_NAME = 4;
const TIER_WORDS_IN_PATH = 5;

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
type Collector = ReturnType<typeof collector>;

/** Per-layout scratch space: one byte per slot for word marks and for history boosts. */
type Scratch = { layout: SearchLayout; marks: Uint8Array; boosts: Uint8Array };

/** A ranked list kept for paging, with the layout its slot orders refer to. */
type Session = { ranks: Float64Array; sorted: boolean; layout: SearchLayout };

const MAX_SESSIONS = 8;
const MAX_SESSION_RANKS = 8_000_000;

/** Per-index state the query layers keep between searches. */
export function createSearchState() {
  let scratch: Scratch | null = null;
  const sessions = new Map<string, Session>();
  return {
    scratch(layout: SearchLayout): Scratch {
      if (scratch?.layout !== layout)
        scratch = {
          layout,
          marks: new Uint8Array(layout.slots),
          boosts: new Uint8Array(layout.slots),
        };
      return scratch;
    },
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

/** Call `visit(slot, at)` for each slot in `range` whose folded name holds `pattern`. */
function scan(
  layout: SearchLayout,
  range: VisibleRange,
  pattern: Buffer,
  prefixOnly: boolean,
  visit: (slot: number, at: number) => void,
) {
  const { folded, foldedStarts } = layout;
  const shift = prefixOnly ? 1 : 0;
  const stop = foldedStarts[range.end] ?? folded.length;
  // `indexOf` has no end bound: a view ending at the range keeps a miss from
  // scanning the rest of the drive, which this caller cannot see.
  const haystack = folded.subarray(0, stop);
  let slot = range.first;
  let position = haystack.indexOf(
    pattern,
    (foldedStarts[range.first] ?? 0) - shift,
  );
  while (position >= 0 && position + shift < stop) {
    const at = position + shift;
    // Gallop forward to the slot containing this match.
    if ((foldedStarts[slot + 1] ?? 0) <= at) {
      let step = 1;
      while (
        slot + step < range.end &&
        (foldedStarts[slot + step + 1] ?? 0) <= at
      )
        step *= 2;
      let low = slot + (step >> 1);
      let high = Math.min(slot + step, range.end - 1);
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if ((foldedStarts[middle] ?? 0) <= at) low = middle;
        else high = middle - 1;
      }
      slot = low;
    }
    visit(slot, at);
    position = haystack.indexOf(pattern, (foldedStarts[slot + 1] ?? 0) - shift);
  }
}

/** Whether `name` holds `term`; single characters match only at its start. */
const nameHolds = (name: string, term: string) =>
  term.length === 1 ? name.startsWith(term) : name.includes(term);

/** Word bits of `terms` held by `name`. */
function termBits(name: string, terms: readonly string[]) {
  let bits = 0;
  for (let i = 0; i < terms.length; i++)
    if (nameHolds(name, terms[i] ?? "")) bits |= 1 << i;
  return bits;
}

/** Literal tier of `needle` at `at` in a name of `length` units, preceded by `before`. */
const literalTier = (exact: boolean, at: number, before: number): number =>
  exact ? 0 : at === 0 ? 1 : before < 128 && boundary[before] ? 2 : 3;

type Query = {
  view: IndexView;
  needle: string;
  terms: string[];
  rootId: number;
  grantSet: Set<number> | null;
  ranges: VisibleRange[];
  boosts: Uint8Array;
  deltaBoosts: Map<number, number>;
  marks: Uint8Array | null;
};

/** Whether a delta entry is inside the root and the caller's grants. */
function deltaVisible(query: Query, id: number) {
  if (id === query.rootId) return false;
  let inRoot = false;
  let inGrant = query.grantSet === null;
  for (
    let current = id;
    current !== NONE;
    current = query.view.parentOf(current)
  ) {
    if (current === query.rootId) inRoot = true;
    if (query.grantSet?.has(current)) inGrant = true;
  }
  return inRoot && inGrant;
}

/** The name layer: `needle` anywhere in a name, or at its start for one character. */
function names(query: Query, results: Collector) {
  const { view, needle, boosts, marks } = query;
  const { layout } = view;
  const { folded, foldedStarts, slots } = layout;
  const prefixOnly = needle.length === 1;
  const pattern = Buffer.from(prefixOnly ? SEPARATOR + needle : needle);
  const needleBytes = pattern.length - (prefixOnly ? 1 : 0);
  for (const range of query.ranges)
    scan(layout, range, pattern, prefixOnly, (slot, at) => {
      const id = layout.slotId[slot] ?? NONE;
      if (!view.isLive(id)) return;
      const start = foldedStarts[slot] ?? 0;
      const length = (foldedStarts[slot + 1] ?? 0) - start - 1;
      if (marks) marks[slot] = (marks[slot] ?? 0) | LITERAL;
      results.add(
        rankOf(
          literalTier(length === needleBytes, at - start, folded[at - 1] ?? 0),
          boosts[slot] ?? 0,
          length,
          slot,
        ),
      );
    });
  for (const [id, name] of view.delta) {
    const at = name.folded.indexOf(needle);
    if (at < 0 || (prefixOnly && at !== 0) || !deltaVisible(query, id))
      continue;
    results.add(
      rankOf(
        literalTier(
          name.folded.length === needle.length,
          at,
          name.folded.charCodeAt(at - 1),
        ),
        query.deltaBoosts.get(id) ?? 0,
        Buffer.byteLength(name.folded),
        slots + id,
      ),
    );
  }
}

/**
 * The words layer: names holding every word, or some words with the rest in
 * the folders above. Names the name layer already found are skipped.
 */
function words(query: Query, results: Collector) {
  const { view, terms, boosts } = query;
  const marks = query.marks;
  if (!marks) return;
  const { layout } = view;
  const { foldedStarts, slotId, slots } = layout;
  const all = (1 << terms.length) - 1;

  // Bits of the folders above each range, which no scan of the range sees.
  const outside = query.ranges.map((range) => {
    let bits = 0;
    for (let id = range.outside; id > ROOT; id = view.parentOf(id))
      bits |= termBits(view.foldedNameOf(id), terms);
    return bits;
  });

  for (let index = 0; index < query.ranges.length; index++) {
    const range = query.ranges[index];
    if (!range) continue;
    const candidates: number[] = [];
    for (let term = 0; term < terms.length; term++) {
      const text = terms[term] ?? "";
      const prefixOnly = text.length === 1;
      const bit = 1 << term;
      scan(
        layout,
        range,
        Buffer.from(prefixOnly ? SEPARATOR + text : text),
        prefixOnly,
        (slot) => {
          const mark = marks[slot] ?? 0;
          if (mark === 0) candidates.push(slot);
          marks[slot] = mark | bit;
        },
      );
    }
    const outer = outside[index] ?? 0;
    for (const slot of candidates) {
      const id = slotId[slot] ?? NONE;
      if (!view.isLive(id)) continue;
      const inName = (marks[slot] ?? 0) & all;
      let bits = inName | outer;
      for (
        let parent = view.parentOf(id);
        bits !== all && parent > ROOT;
        parent = view.parentOf(parent)
      ) {
        const parentSlot = view.slotOf(parent);
        if (parentSlot < range.first) break;
        bits |= (marks[parentSlot] ?? 0) & all;
      }
      if (bits !== all) continue;
      const start = foldedStarts[slot] ?? 0;
      results.add(
        rankOf(
          inName === all ? TIER_WORDS_IN_NAME : TIER_WORDS_IN_PATH,
          boosts[slot] ?? 0,
          (foldedStarts[slot + 1] ?? 0) - start - 1,
          slot,
        ),
      );
    }
  }

  for (const [id, name] of view.delta) {
    if (name.folded.includes(query.needle)) continue;
    const inName = termBits(name.folded, terms);
    if (inName === 0 || !deltaVisible(query, id)) continue;
    let bits = inName;
    for (
      let parent = view.parentOf(id);
      bits !== all && parent > ROOT;
      parent = view.parentOf(parent)
    )
      bits |= termBits(view.foldedNameOf(parent), terms);
    if (bits !== all) continue;
    results.add(
      rankOf(
        inName === all ? TIER_WORDS_IN_NAME : TIER_WORDS_IN_PATH,
        query.deltaBoosts.get(id) ?? 0,
        Buffer.byteLength(name.folded),
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
    const order = orderOf(rank);
    const id =
      order < layout.slots
        ? (layout.slotId[order] ?? NONE)
        : order - layout.slots;
    if (!view.isLive(id)) continue;
    hits.push({
      path: view.pathOf(id),
      type: view.isFolder(id) ? "dir" : "file",
      match: tierOf(rank) < TIER_WORDS_IN_NAME ? "name" : "words",
    });
  }
  return { hits, next: at < ranks.length ? at : null };
}

export function runSearch(
  view: IndexView,
  state: SearchState,
  request: SearchRequest,
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
  const scratch = state.scratch(layout);
  const query: Query = {
    view,
    needle,
    terms,
    rootId,
    grantSet: granted ? new Set(granted) : null,
    ranges: view.visibleRanges(rootId, granted),
    boosts: scratch.boosts,
    deltaBoosts: new Map(),
    marks: terms.length ? scratch.marks : null,
  };
  const boosted: number[] = [];
  const now = Date.now();
  for (const entry of request.history ?? []) {
    const id = view.find(entry.path);
    if (id === NONE) continue;
    const boost = historyBoost(entry, now);
    const slot = view.slotOf(id);
    if (slot === NONE) query.deltaBoosts.set(id, boost);
    else {
      scratch.boosts[slot] = boost;
      boosted.push(slot);
    }
  }
  if (query.marks)
    for (const range of query.ranges)
      query.marks.fill(0, range.first, range.end);

  const results = collector(offset + limit, key !== null);
  try {
    names(query, results);
    if (terms.length) words(query, results);
  } finally {
    for (const slot of boosted) scratch.boosts[slot] = 0;
  }

  const ranked = results.all();
  if (key && ranked && results.total > offset + limit)
    state.keep(key, { ranks: ranked, sorted: false, layout });
  const best = results.best();
  const page = hitsFor(view, layout, best, offset, limit);
  return {
    hits: page.hits,
    truncated: results.total > offset + page.hits.length,
    total: results.total,
    next: results.total > offset + limit ? offset + limit : null,
    terms: matchedTerms,
  };
}
