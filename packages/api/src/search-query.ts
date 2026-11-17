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
 * then. Nothing is stored between pages, and no surviving match is repeated
 * or skipped. Compaction renumbers slots, so the index keeps the previous
 * layout's numbering to translate a cursor from just before one; a cursor
 * older than that, or one ranked with different history, gets every result
 * up to the end of its next page again instead, so nothing is skipped and the
 * caller drops the repeats.
 *
 * Nothing a caller sees depends on names outside the ranges it may read:
 * which layers run, which corrections are tried, every count and the order.
 */
import {
  collector,
  foldQuery,
  MAX_BOOST,
  MAX_TERMS,
  queryTerms,
  Rank,
  ScanCounts,
  scanLayout,
  ScanScratch,
  slotHolds,
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
import { lowerSlot, type SearchWords, type Visibility } from "./search-words";

export { foldName, foldQuery } from "./search-scan";
export type {
  CompactRanks,
  ScanCounts,
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
  /** The clock history decays against, in ms; defaults to now. A continued page keeps its first page's. */
  now?: number;
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
  /**
   * The drive changed too much since the previous page to continue it, so
   * this page starts again from the first result: it repeats results
   * already returned, and skips none.
   */
  restarted: boolean;
  /** Folded words that matched, for highlighting. Never sent to clients as-is. */
  terms: string[];
};

/** What the query layers need from an index. */
export type IndexView = {
  readonly layout: SearchLayout;
  /**
   * The layout before the last compaction, with each id's slot in it then,
   * to continue a page ranked in it. Null before the first compaction.
   */
  readonly previous: {
    generation: number;
    slots: number;
    slotOf: Int32Array;
  } | null;
  /** Entries added since the layout was built, with folded names. */
  readonly delta: ReadonlyMap<number, { raw: string; folded: string }>;
  readonly words: SearchWords;
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
 * Corrections tried per misspelled word, best first. Chosen with the
 * relevance sets and the benchmark; see the search report.
 */
export const MAX_CORRECTIONS = 4;

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

/** A short digest of the history a page was ranked with. */
function historyDigest(history: readonly HistoryEntry[]) {
  let hash = 0x811c9dc5;
  for (const entry of history) {
    const text = `${entry.path}\0${entry.openedAt}\0${entry.visits}\0${entry.starred ? 1 : 0}\n`;
    for (let i = 0; i < text.length; i++)
      hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Where a page ended: the layout it was ranked in, its last rank, how many
 * came before, and the clock and history its ranks were computed with.
 */
type Cursor = {
  generation: number;
  after: number;
  shown: number;
  now: number;
  history: number;
};

const Cursor = {
  format: (cursor: Cursor) =>
    `${cursor.generation}-${cursor.after}-${cursor.shown}-${cursor.now}-${cursor.history}`,
  /** Null for text that no page returned; such a search starts over. */
  parse(text: string | undefined): Cursor | null {
    const parts =
      /^(\d{1,15})-(\d{1,16})-(\d{1,9})-(\d{1,15})-(\d{1,10})$/.exec(
        text ?? "",
      );
    if (!parts) return null;
    return {
      generation: Number(parts[1]),
      after: Number(parts[2]),
      shown: Number(parts[3]),
      now: Number(parts[4]),
      history: Number(parts[5]),
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
      counts: ScanCounts,
    ) {
      if (scratch?.layout !== layout)
        scratch = { layout, space: ScanScratch.for(layout) };
      const { space } = scratch;
      ScanScratch.setBoosts(space, plan);
      try {
        scanLayout(layout, plan, space, add, counts);
      } finally {
        ScanScratch.clearBoosts(space, plan);
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
  if (id === rootId || !view.isLive(id)) return false;
  let inRoot = false;
  let inGrant = grants === null;
  for (let current = id; current !== NONE; current = view.parentOf(current)) {
    if (current === rootId) inRoot = true;
    if (grants?.has(current)) inGrant = true;
  }
  return inRoot && inGrant;
}

/** The fuzzy layer's corrections as entries added since compaction see them. */
type DeltaFuzzy = {
  terms: readonly string[];
  /** Per word, the corrections tried, for highlighting. */
  words: readonly (readonly string[])[];
  /** Per word, ids of delta names holding one of its corrections. */
  ids: readonly ReadonlySet<number>[];
  /** Per word, compacted posting keys of its corrections, for folders above. */
  keys: readonly (readonly number[])[];
};

/** The layers over entries added since compaction, by the same rules as search-scan.ts. */
function scanDelta(
  view: IndexView,
  plan: ScanPlan,
  rootId: number,
  grants: Set<number> | null,
  boosts: ReadonlyMap<number, number>,
  keep: (rank: number) => boolean,
  add: (rank: number) => void,
  counts: ScanCounts,
  corrections: DeltaFuzzy | null,
) {
  const { needle, terms } = plan;
  const prefixOnly = needle.length === 1;
  const { layout } = view;
  const { slots } = layout;
  /** Bits of `bitsOf` across the folders above `id`, stopping once `full`. */
  const above = (
    id: number,
    bits: number,
    full: number,
    bitsOf: (folder: number) => number,
  ) => {
    for (
      let parent = view.parentOf(id);
      bits !== full && parent > ROOT;
      parent = view.parentOf(parent)
    )
      bits |= bitsOf(parent);
    return bits;
  };
  const correctedBits = (id: number) => {
    if (!corrections) return 0;
    let bits = termBits(view.foldedNameOf(id), corrections.terms);
    const slot = view.slotOf(id);
    corrections.ids.forEach((ids, term) => {
      const held =
        slot === NONE
          ? ids.has(id)
          : slotHolds(layout, slot, corrections.keys[term] ?? []);
      if (held) bits |= 1 << term;
    });
    return bits;
  };
  for (const [id, name] of view.delta) {
    if (!deltaVisible(view, id, rootId, grants)) continue;
    const at = name.folded.indexOf(needle);
    const literal = at >= 0 && (!prefixOnly || at === 0);
    const inName = terms.length ? termBits(name.folded, terms) : 0;
    if (literal) counts.literal++;
    for (let term = 0; term < terms.length; term++)
      if (inName & (1 << term))
        counts.terms[term] = (counts.terms[term] ?? 0) + 1;
    const boost = boosts.get(id) ?? 0;
    const length = Buffer.byteLength(name.folded);
    const offer = (rank: number) => {
      if (keep(rank)) add(rank);
    };
    if (literal) {
      offer(
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
    const all = (1 << terms.length) - 1;
    if (
      inName !== 0 &&
      above(id, inName, all, (folder) =>
        termBits(view.foldedNameOf(folder), terms),
      ) === all
    ) {
      offer(
        Rank.of(
          inName === all ? TIER_WORDS_IN_NAME : TIER_WORDS_IN_PATH,
          boost,
          length,
          slots + id,
        ),
      );
      continue;
    }
    if (!corrections) continue;
    const fuzzyAll = (1 << corrections.terms.length) - 1;
    const fuzzyInName = correctedBits(id);
    if (
      fuzzyInName !== 0 &&
      above(id, fuzzyInName, fuzzyAll, correctedBits) === fuzzyAll
    )
      offer(
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
  restarted: false,
  terms: [],
});

/**
 * A search ready for its compacted scan: run `plan` over `layout` keeping the
 * best `limit` ranks, then pass them to `finish`, which matches the entries
 * added since compaction and returns the page, or a second scan when the
 * fuzzy layer should run too. `keep`, when set, filters ranks in a way scan
 * workers cannot (a cursor from the previous layout): scan on this thread.
 */
export type PreparedSearch =
  | { done: SearchResult }
  | {
      done: null;
      layout: SearchLayout;
      plan: ScanPlan;
      limit: number;
      keep: ((rank: number) => boolean) | null;
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
  const grants = granted ? new Set(granted) : null;
  const full = request.depth === "full";
  const allTerms = queryTerms(needle);
  const usable = allTerms.length <= MAX_TERMS;
  const terms =
    full && usable && !(allTerms.length === 1 && allTerms[0] === needle)
      ? allTerms
      : [];
  const history = request.history ?? [];
  const digest = historyDigest(history);
  const { layout } = view;
  const ranges = view.visibleRanges(rootId, granted);

  // Continue a page: after its last rank within its layout; through the
  // previous layout's numbering just after a compaction; otherwise by
  // returning everything up to the end of this page again.
  const cursor = Cursor.parse(request.cursor);
  const sameHistory = cursor !== null && cursor.history === digest;
  const previous = view.previous;
  const mode =
    cursor === null
      ? "start"
      : sameHistory && cursor.generation === layout.generation
        ? "continue"
        : sameHistory && previous && cursor.generation === previous.generation
          ? "translate"
          : "again";
  const shown = cursor?.shown ?? 0;
  const now = cursor?.now ?? request.now ?? Date.now();
  const before = mode === "continue" || mode === "translate" ? shown : 0;
  const want = (mode === "again" ? shown : 0) + limit;
  const after = cursor && mode === "continue" ? cursor.after : -1;
  /** For "translate": whether a rank in this layout came after the cursor in the previous one. */
  const keep: ((rank: number) => boolean) | null =
    cursor && previous && mode === "translate"
      ? (rank) => {
          const order = Rank.order(rank);
          const id =
            order < layout.slots
              ? (layout.slotId[order] ?? NONE)
              : order - layout.slots;
          const old =
            id >= 0 && id < previous.slotOf.length
              ? (previous.slotOf[id] ?? NONE)
              : NONE;
          return (
            rank - order + (old === NONE ? previous.slots + id : old) >
            cursor.after
          );
        }
      : null;

  const boosts: number[] = [];
  const deltaBoosts = new Map<number, number>();
  for (const entry of history) {
    const id = view.find(entry.path);
    if (id === NONE) continue;
    const boost = historyBoost(entry, now);
    const slot = view.slotOf(id);
    if (slot === NONE) deltaBoosts.set(id, boost);
    else boosts.push(slot, boost);
  }

  /** Visible live names holding a word, for choosing corrections. */
  const visibility: Visibility = {
    baseCount: (index, cap) => {
      const { postingStart, postingSlots, dead } = layout;
      const end = postingStart[index + 1] ?? 0;
      let count = 0;
      for (const range of ranges) {
        for (
          let at = lowerSlot(
            postingSlots,
            postingStart[index] ?? 0,
            end,
            range.first,
          );
          at < end && count < cap;
          at++
        ) {
          const slot = postingSlots[at] ?? 0;
          if (slot >= range.end) break;
          if (!dead[slot]) count++;
        }
        if (count >= cap) break;
      }
      return count;
    },
    deltaVisible: (id) => deltaVisible(view, id, rootId, grants),
  };

  const step = (
    plan: ScanPlan,
    corrections: DeltaFuzzy | null,
  ): PreparedSearch => ({
    done: null,
    layout,
    plan,
    limit: want,
    keep,
    finish: (compacted) => {
      const results = collector(want);
      results.merge(compacted);
      const counts = ScanCounts.none(plan.terms.length);
      ScanCounts.add(counts, compacted.counts);
      scanDelta(
        view,
        plan,
        rootId,
        grants,
        deltaBoosts,
        keep ?? ((rank) => rank > plan.after),
        (rank) => results.add(rank),
        counts,
        corrections,
      );
      // Words no visible name holds, corrected to words visible names hold.
      if (plan.fuzzy === null && full && usable && allTerms.length) {
        const missing = allTerms.map((term, index) =>
          plan.terms.length
            ? (counts.terms[index] ?? 0) === 0
            : counts.literal === 0,
        );
        const fixes = allTerms.map((term, index) =>
          missing[index]
            ? view.words.corrections(term, visibility, MAX_CORRECTIONS)
            : [],
        );
        if (fixes.some((list) => list.length)) {
          const expansions = fixes.map((list) =>
            list.map((word) => view.words.expand(word)),
          );
          const keys = expansions.map((list) => [
            ...new Set(list.flatMap((expansion) => expansion.base)),
          ]);
          return step(
            { ...plan, fuzzy: { terms: allTerms, keys } },
            {
              terms: allTerms,
              words: fixes,
              keys,
              ids: expansions.map(
                (list) =>
                  new Set(
                    list.flatMap((expansion) =>
                      expansion.delta.flatMap((key) =>
                        view.words.deltaIds(key),
                      ),
                    ),
                  ),
              ),
            },
          );
        }
      }
      const best = results.best();
      const hits: SearchHit[] = [];
      let last = -1;
      for (let at = 0; at < best.length; at++) {
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
      const fixed = corrections
        ? [...corrections.terms, ...corrections.words.flat()]
        : [];
      return {
        done: {
          hits,
          truncated: more,
          total: before + results.total,
          restarted: mode === "again",
          next: more
            ? Cursor.format({
                generation: layout.generation,
                after: last,
                shown: before + hits.length,
                now,
                history: digest,
              })
            : null,
          terms: corrections
            ? [...new Set(fixed)]
            : terms.length
              ? terms
              : [needle],
        },
      };
    },
  });
  return step({ needle, terms, fuzzy: null, ranges, boosts, after }, null);
}

/** Scan the compacted names on this thread. */
export function scanCompacted(
  state: SearchState,
  layout: SearchLayout,
  plan: ScanPlan,
  limit: number,
  keep: ((rank: number) => boolean) | null,
): CompactRanks {
  const results = collector(limit);
  const counts = ScanCounts.none(plan.terms.length);
  state.scanHere(
    layout,
    plan,
    keep
      ? (rank) => {
          if (keep(rank)) results.add(rank);
        }
      : (rank) => results.add(rank),
    counts,
  );
  return { best: results.best(), total: results.total, counts };
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
      scanCompacted(
        state,
        prepared.layout,
        prepared.plan,
        prepared.limit,
        prepared.keep,
      ),
    );
  return prepared.done;
}
