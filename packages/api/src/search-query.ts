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
 * layout's numbering, and a page continued across a compaction is ranked,
 * and the rest of its session continued, in that layout's order: the new
 * order places entries added before the compaction among their equals, which
 * could put results already shown after the cursor. A cursor that is two
 * compactions old, or one ranked with different history, for another
 * request, from an earlier run, or unreadable, restarts: its page is the
 * first page again, flagged `restarted`, and paging on from it skips
 * nothing. A restart costs what a first page costs, however deep the cursor.
 *
 * Nothing a caller sees depends on names outside the ranges it may read:
 * which layers run, which corrections are tried, every count and the order.
 * Two things still depend, coarsely, on how much the whole drive changed:
 * whether a later page restarts (after two compactions, each needing at
 * least 20,000 changes anywhere or a quarter of the layout once that is
 * larger, search-index.ts; or after a rebuild, which needs more removals
 * than there are names), and how equally ranked results order (those
 * added since the last compaction come after their compacted equals until
 * the next one). Neither depends on any name, and sealed cursors are all one
 * length (search-cursor.ts).
 */
import {
  collector,
  foldQuery,
  type Stopped,
  MAX_BOOST,
  MAX_TERMS,
  queryTerms,
  Rank,
  ScanCounts,
  scanLayout,
  ScanScratch,
  slotHolds,
  termBits,
  TIER_DATES_IN_NAME,
  TIER_DATES_IN_PATH,
  TIER_SPLIT_IN_NAME,
  TIER_SPLIT_IN_PATH,
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
import {
  dateSpellings,
  joinedWords,
  monthNamed,
  plain,
  queryDates,
} from "./search-text";

export { foldName, foldQuery } from "./search-scan";
export type {
  CompactRanks,
  ScanCounts,
  ScanPlan,
  SearchLayout,
  Stopped,
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
  /**
   * Continue after the page that returned this `next`. Text no page returned
   * (or one for another request, or from an earlier run) restarts the search.
   */
  cursor?: string;
  /** The clock history decays against, in ms; defaults to now. A continued page keeps its first page's. */
  now?: number;
  /**
   * When nobody waits for the answer any more, in `Date.now()` ms: work on
   * this thread past it throws `SearchStopped`. None by default.
   */
  deadline?: number;
};

/** A search ran past its request's deadline, so it was abandoned unanswered. */
export class SearchStopped extends Error {
  constructor(deadline: number) {
    super(
      `The search ran past its deadline (${new Date(deadline).toISOString()}) and was stopped; nobody waits for its answer any more. Nothing changed.`,
    );
    this.name = "SearchStopped";
  }
}

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
   * The previous page could not be continued (see the module comment), so
   * this is the first page again: callers replace what they show with it,
   * and paging on from its `next` skips nothing.
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
    /** The id in each of its slots. */
    slotId: Int32Array;
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

/** A short digest of `parts`, for telling whether two pages used the same. */
function digestOf(parts: readonly string[]) {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++)
      hash = Math.imul(hash ^ part.charCodeAt(i), 0x01000193);
    hash = Math.imul(hash ^ 0x0a, 0x01000193);
  }
  return hash >>> 0;
}

/** A short digest of the history a page was ranked with. */
const historyDigest = (history: readonly HistoryEntry[]) =>
  digestOf(
    history.map(
      (entry) =>
        `${entry.path}\0${entry.openedAt}\0${entry.visits}\0${entry.starred ? 1 : 0}`,
    ),
  );

/**
 * Where a page ended: the layout it was ranked in, its last rank, how many
 * came before, and the clock and history its ranks were computed with, for
 * the request it answered (query, folder, depth and scope). Also
 * which words the typo layer corrected (bits of the query's words) and a
 * digest of every other reading tried, so later pages read the query the
 * same way however the names it was decided on change.
 */
type Cursor = {
  generation: number;
  after: number;
  shown: number;
  now: number;
  history: number;
  request: number;
  missing: number;
  readings: number;
};

const Cursor = {
  format: (cursor: Cursor) =>
    `${cursor.generation}-${cursor.after}-${cursor.shown}-${cursor.now}-${cursor.history}-${cursor.request}-${cursor.missing}-${cursor.readings}`,
  /** Null for text that no page returned; such a search restarts. */
  parse(text: string): Cursor | null {
    const parts =
      /^(\d{1,15})-(\d{1,16})-(\d{1,9})-(\d{1,15})-(\d{1,10})-(\d{1,10})-(\d{1,2})-(\d{1,10})$/.exec(
        text,
      );
    if (!parts) return null;
    return {
      generation: Number(parts[1]),
      after: Number(parts[2]),
      shown: Number(parts[3]),
      now: Number(parts[4]),
      history: Number(parts[5]),
      request: Number(parts[6]),
      missing: Number(parts[7]),
      readings: Number(parts[8]),
    };
  },
} as const;

/** What a page's results depend on in its request, besides the cursor and history. */
const requestDigest = (request: SearchRequest) =>
  digestOf([
    request.query,
    request.root,
    request.depth ?? "instant",
    ...(request.scope.type === "all"
      ? ["\0all"]
      : ["\0grants", ...[...request.scope.paths].sort()]),
  ]);

/** How a page reads the query's words beyond as typed; see `Cursor`. */
type Readings = { missing: number; readings: number };

/** Per-index scratch space for scans on this thread, reused while a layout lasts. */
export function createSearchState() {
  let scratch: { layout: SearchLayout; space: ScanScratch } | null = null;
  return {
    /** False when `stopped` ended the scan early. */
    scanHere(
      layout: SearchLayout,
      plan: ScanPlan,
      add: (rank: number) => void,
      counts: ScanCounts,
      stopped: Stopped,
    ) {
      if (scratch?.layout !== layout)
        scratch = { layout, space: ScanScratch.for(layout) };
      const { space } = scratch;
      ScanScratch.setBoosts(space, plan);
      try {
        return scanLayout(layout, plan, space, add, counts, stopped);
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
  /** Bits of the words whose other readings are typo corrections; the rest are dates. */
  corrected: number;
  /** Per word, the corrections tried, for highlighting. */
  words: readonly (readonly string[])[];
  /** Per word, ids of delta names holding one of its corrections. */
  ids: readonly ReadonlySet<number>[];
  /** Per word, compacted posting keys of its corrections, for folders above. */
  keys: readonly (readonly number[])[];
};

/**
 * The names-layer tier of `needle` in folded `name`, as typed or else
 * without accents; null when it is not there. The same rules as the scan.
 */
function literalIn(name: string, needle: string, prefixOnly: boolean) {
  const tierAt = (
    text: string,
    query: string,
    at: number,
    plainForm: boolean,
  ) =>
    at < 0 || (prefixOnly && at !== 0)
      ? null
      : Rank.literalTier(
          text.length === query.length,
          at,
          text.charCodeAt(at - 1),
          plainForm,
        );
  const asTyped = tierAt(name, needle, name.indexOf(needle), false);
  if (asTyped !== null) return asTyped;
  const plainNeedle = plain(needle);
  if (plainNeedle !== needle) {
    const inName = tierAt(name, plainNeedle, name.indexOf(plainNeedle), true);
    if (inName !== null) return inName;
  }
  const plainName = plain(name);
  return plainName === name
    ? null
    : tierAt(plainName, plainNeedle, plainName.indexOf(plainNeedle), true);
}

/** The layers over entries added since compaction, by the same rules as search-scan.ts. */
function scanDelta(
  view: IndexView,
  plan: ScanPlan,
  rootId: number,
  grants: Set<number> | null,
  boosts: ReadonlyMap<number, number>,
  /** The rank to collect for a match's, or -1 to leave it out. */
  offered: (rank: number) => number,
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
  const typedBits = (id: number) =>
    corrections ? termBits(view.foldedNameOf(id), corrections.terms) : 0;
  const otherBits = (id: number) => {
    if (!corrections) return 0;
    let bits = 0;
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
    const literal = literalIn(name.folded, needle, prefixOnly);
    const inName = terms.length ? termBits(name.folded, terms) : 0;
    if (literal !== null) counts.literal++;
    for (let term = 0; term < terms.length; term++)
      if (inName & (1 << term))
        counts.terms[term] = (counts.terms[term] ?? 0) + 1;
    const boost = boosts.get(id) ?? 0;
    const length = Buffer.byteLength(name.folded);
    const offer = (rank: number) => {
      const kept = offered(rank);
      if (kept >= 0) add(kept);
    };
    if (literal !== null) {
      offer(Rank.of(literal, boost, length, slots + id));
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
    const split = plan.split;
    if (split) {
      const splitAll = (1 << split.length) - 1;
      const splitInName = termBits(name.folded, split);
      if (
        splitInName !== 0 &&
        above(id, splitInName, splitAll, (folder) =>
          termBits(view.foldedNameOf(folder), split),
        ) === splitAll
      ) {
        offer(
          Rank.of(
            splitInName === splitAll ? TIER_SPLIT_IN_NAME : TIER_SPLIT_IN_PATH,
            boost,
            length,
            slots + id,
          ),
        );
        continue;
      }
    }
    if (!corrections) continue;
    const otherAll = (1 << corrections.terms.length) - 1;
    let typed = typedBits(id);
    let other = otherBits(id);
    const otherInName = typed | other;
    if (otherInName === 0) continue;
    for (
      let parent = view.parentOf(id);
      (typed | other) !== otherAll && parent > ROOT;
      parent = view.parentOf(parent)
    ) {
      typed |= typedBits(parent);
      other |= otherBits(parent);
    }
    if ((typed | other) !== otherAll) continue;
    const fuzzyMatch = (other & ~typed & corrections.corrected) !== 0;
    const allInName = otherInName === otherAll;
    offer(
      Rank.of(
        fuzzyMatch
          ? allInName
            ? TIER_FUZZY_IN_NAME
            : TIER_FUZZY_IN_PATH
          : allInName
            ? TIER_DATES_IN_NAME
            : TIER_DATES_IN_PATH,
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
 * fuzzy layer should run too. `translate`, when set, maps ranks in a way scan
 * workers cannot (a cursor from the previous layout): scan on this thread.
 */
export type PreparedSearch =
  | { done: SearchResult }
  | {
      done: null;
      layout: SearchLayout;
      plan: ScanPlan;
      limit: number;
      translate: ((rank: number) => number) | null;
      /** True once the request's deadline has passed. */
      stopped: Stopped;
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

export const prepareSearch = (
  view: IndexView,
  request: SearchRequest,
): PreparedSearch =>
  prepare(
    view,
    request,
    request.cursor === undefined
      ? null
      : (Cursor.parse(request.cursor) ?? "unusable"),
  );

/** `prepareSearch` with the request's cursor read, or "unusable" to restart. */
function prepare(
  view: IndexView,
  request: SearchRequest,
  cursor: Cursor | "unusable" | null,
): PreparedSearch {
  const { root, limit, scope, deadline } = request;
  const stopped: Stopped =
    deadline === undefined ? () => false : () => Date.now() > deadline;
  /** Throw once the deadline has passed. */
  const check = () => {
    if (deadline !== undefined && stopped()) throw new SearchStopped(deadline);
  };
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
  // Joined words read apart: the words as typed (case and all), each split
  // where it joins words, when any does.
  const typedWords = request.query
    .trim()
    .split(/[\s/]+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  const splitWords = [
    ...new Set(
      typedWords.flatMap((word) => {
        const parts = joinedWords(word);
        return parts.length ? parts : [foldQuery(word)];
      }),
    ),
  ];
  const split =
    full &&
    typedWords.some((word) => joinedWords(word).length) &&
    splitWords.length <= MAX_TERMS
      ? splitWords
      : null;
  const history = request.history ?? [];
  const digest = historyDigest(history);
  const { layout } = view;
  const ranges = view.visibleRanges(rootId, granted);

  // Continue a page: after its last rank within its layout; through the
  // previous layout's numbering just after a compaction; otherwise from the
  // first result again.
  const asked = requestDigest(request);
  // A cursor for another request, or ranked with other history, restarts.
  const parsed =
    cursor === "unusable" || cursor?.request !== asked ? null : cursor;
  const sameHistory = parsed !== null && parsed.history === digest;
  const previous = view.previous;
  const mode =
    cursor === null
      ? "start"
      : sameHistory && parsed.generation === layout.generation
        ? "continue"
        : sameHistory && previous && parsed.generation === previous.generation
          ? "translate"
          : "again";
  /** The page this one continues, when it does. */
  const continued =
    parsed && (mode === "continue" || mode === "translate") ? parsed : null;
  const now = parsed?.now ?? request.now ?? Date.now();
  const before = continued?.shown ?? 0;
  const want = limit;
  const after = parsed && mode === "continue" ? parsed.after : -1;
  /**
   * For "translate": a rank in this layout as the previous one ranks it, or
   * -1 when it came no later than the cursor there. The whole page is ranked
   * and continued in that order, so what earlier pages showed stays before
   * the cursor however this compaction reordered entries.
   */
  const translate: ((rank: number) => number) | null =
    parsed && previous && mode === "translate"
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
          const ranked =
            rank - order + (old === NONE ? previous.slots + id : old);
          return ranked > parsed.after ? ranked : -1;
        }
      : null;
  /** The layout the page's ranks are in, to turn them back into entries. */
  const rankedIn =
    translate && previous
      ? {
          generation: previous.generation,
          slots: previous.slots,
          slotId: previous.slotId,
        }
      : layout;

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
    read: Readings,
  ): PreparedSearch => ({
    done: null,
    layout,
    plan,
    limit: want,
    translate,
    stopped,
    finish: (compacted) => {
      check();
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
        translate ?? ((rank) => (rank > plan.after ? rank : -1)),
        (rank) => results.add(rank),
        counts,
        corrections,
      );
      check();
      let pageReadings = read;
      // Other readings of the query's words: dates written any way, and
      // words no visible name holds corrected to words visible names hold.
      if (plan.fuzzy === null && full && usable && allTerms.length) {
        // A continued page corrects the words its first page did.
        const missing = allTerms.map((term, index) =>
          continued
            ? (continued.missing & (1 << index)) !== 0
            : plan.terms.length
              ? (counts.terms[index] ?? 0) === 0
              : counts.literal === 0,
        );
        const dates = allTerms.map((term, index) => {
          const days = queryDates(term);
          if (days.length) return days;
          // A month named next to a year: "march 2024".
          const month = monthNamed(term);
          const year = [allTerms[index - 1], allTerms[index + 1]].find(
            (word) => word !== undefined && /^(19|20)\d{2}$/.test(word),
          );
          return month !== null && year !== undefined
            ? [`M${year}${String(month).padStart(2, "0")}`]
            : [];
        });
        const fixes = allTerms.map((term, index) =>
          missing[index] && !dates[index]?.length
            ? view.words.corrections(term, visibility, MAX_CORRECTIONS, stopped)
            : [],
        );
        check();
        const readings = allTerms.map((_, index) => [
          ...(dates[index] ?? []),
          ...(fixes[index] ?? []),
        ]);
        const decided: Readings = {
          missing: missing.reduce(
            (bits, word, index) => (word ? bits | (1 << index) : bits),
            0,
          ),
          readings: digestOf(readings.map((list) => list.join("\0"))),
        };
        // The corrections chosen changed with the names since the page this
        // continues: its cursor ranks a different result set, so restart.
        if (continued && decided.readings !== continued.readings)
          return prepare(view, request, "unusable");
        pageReadings = decided;
        if (readings.some((list) => list.length)) {
          const expansions = readings.map((list) =>
            list.map((word) => view.words.expand(word)),
          );
          const keys = expansions.map((list) => [
            ...new Set(list.flatMap((expansion) => expansion.base)),
          ]);
          let corrected = 0;
          fixes.forEach((list, index) => {
            if (list.length) corrected |= 1 << index;
          });
          return step(
            { ...plan, fuzzy: { terms: allTerms, keys, corrected } },
            {
              terms: allTerms,
              corrected,
              words: readings.map((list) =>
                list.flatMap((word) =>
                  word.startsWith("D") || word.startsWith("M")
                    ? dateSpellings(word)
                    : [word],
                ),
              ),
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
            decided,
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
          order < rankedIn.slots
            ? (rankedIn.slotId[order] ?? NONE)
            : order - rankedIn.slots;
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
                generation: rankedIn.generation,
                after: last,
                shown: before + hits.length,
                now,
                history: digest,
                request: asked,
                ...pageReadings,
              })
            : null,
          terms: [
            ...new Set([
              ...(corrections ? fixed : terms.length ? terms : [needle]),
              ...(split ?? []),
            ]),
          ],
        },
      };
    },
  });
  return step(
    { needle, terms, split, fuzzy: null, ranges, boosts, after },
    null,
    { missing: 0, readings: 0 },
  );
}

/**
 * Scan the compacted names on this thread. Once `stopped`, the ranks are
 * partial, and the search's `finish` throws `SearchStopped` instead of
 * using them.
 */
export function scanCompacted(
  state: SearchState,
  layout: SearchLayout,
  plan: ScanPlan,
  limit: number,
  translate: ((rank: number) => number) | null,
  stopped: Stopped = () => false,
): CompactRanks {
  const results = collector(limit);
  const counts = ScanCounts.none(plan.terms.length);
  state.scanHere(
    layout,
    plan,
    translate
      ? (rank) => {
          const kept = translate(rank);
          if (kept >= 0) results.add(kept);
        }
      : (rank) => results.add(rank),
    counts,
    stopped,
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
        prepared.translate,
        prepared.stopped,
      ),
    );
  return prepared.done;
}
