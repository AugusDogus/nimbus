/**
 * The compacted half of a search: scans of an index layout's packed names,
 * using only slot-indexed arrays that compaction builds once and never
 * changes, plus the `dead` marks of entries removed since. It reads nothing
 * else, so a scan worker can run it over its share of the slots while the
 * index keeps changing on its own thread.
 *
 * Three layers run here, each over only the ranges the caller may see:
 * - names: the whole query as a substring of a name, ranked exact, prefix,
 *   word boundary, then anywhere;
 * - words: every word of the query in the name or in a folder above it, at
 *   least one in the name. One scan per word marks the slots whose names hold
 *   it; a candidate's folders are checked through those marks by walking up
 *   the tree, so full paths are never built;
 * - fuzzy: the same, with misspelled or abbreviated words replaced by words
 *   the caller's own names hold, found through the word-to-name postings
 *   (search-words.ts) rather than another scan.
 */

/** The compacted part of an index, replaced (never changed) by compaction. */
export type SearchLayout = {
  /** Folded names as UTF-8, each preceded by a NUL, in depth-first order. */
  readonly folded: Buffer;
  /** Byte offset of each slot's name in `folded`; one extra entry ends the last. */
  readonly foldedStarts: Int32Array;
  /** The index id in each slot, to turn ranks back into entries. */
  readonly slotId: Int32Array;
  /** The slot after each slot's subtree. */
  readonly subtreeEnd: Int32Array;
  /** Each slot's parent folder's slot; -1 for the root. */
  readonly parentSlot: Int32Array;
  /** 1 for entries removed since compaction. The only part that changes. */
  readonly dead: Uint8Array;
  readonly slots: number;
  /** Distinct for every layout any index builds, so a page cursor can tell its layout. */
  readonly generation: number;
  /**
   * The plain (accent-free, search-text.ts) names of the slots whose plain
   * name differs from their folded one, packed like `folded`: entry i is
   * slot `plainSlot[i]`, in slot order. Usually a small share of the names.
   */
  readonly plain: Buffer;
  readonly plainStarts: Int32Array;
  readonly plainSlot: Int32Array;
  /** Word-to-name postings for these slots (search-words.ts): key i's slots, sorted. */
  readonly postingStart: Int32Array;
  readonly postingSlots: Int32Array;
};

/**
 * A slot range a caller may see, and the slot of the nearest folder above it
 * outside the range (-1 for none). The folders from there up are the range's
 * path context, which no scan of the range itself sees.
 */
export type VisibleRange = { first: number; end: number; outside: number };

/** What one scan of a layout looks for. */
export type ScanPlan = {
  needle: string;
  /** Words for the words layer; empty runs the names layer only. */
  terms: readonly string[];
  /**
   * For the fuzzy layer: every query word, and for each the posting keys of
   * the words it may have meant (none for a word some visible name holds).
   * Null skips the layer.
   */
  fuzzy: {
    terms: readonly string[];
    keys: readonly (readonly number[])[];
    /** Bits of the words whose other readings are typo corrections; the rest are dates. */
    corrected: number;
  } | null;
  ranges: readonly VisibleRange[];
  /** Flat [slot, boost, slot, boost, ...] pairs from the caller's history. */
  boosts: readonly number[];
  /**
   * The query's words with joined ones (`backupPhotos`) read apart, for a
   * pass of its own below the words as typed; null when none are joined.
   */
  split: readonly string[] | null;
  /** Only ranks after this one, to continue a page; -1 for all. */
  after: number;
  /**
   * Run the fuzzy layer only: the previous scan of this search, with the
   * same plan but no fuzzy layer, ran the others and left its marks in the
   * same scratch space (`marksEarlierLayers`), and the caller keeps its ranks.
   */
  fuzzyOnly: boolean;
};

/** Whether a scan of `plan` leaves the marks the fuzzy layer needs, so a fuzzy-only scan can follow it. */
export const marksEarlierLayers = (plan: ScanPlan) =>
  plan.terms.length > 0 || plan.split !== null;

import { plain, queryDates } from "./search-text";

const SEPARATOR = "\0";

const boundary = new Uint8Array(128);
for (const char of " _-.()[]+,@#&'") boundary[char.charCodeAt(0)] = 1;

export { foldName, foldQuery } from "./search-text";

/** A word that is a whole day written with slashes (3/15/2024), not folders. */
const slashDay = (word: string) =>
  word.includes("/") && queryDates(word).some((key) => key.startsWith("D"));

/**
 * Words of a folded query, split at spaces and "/" (folders), except a day
 * written with slashes, without bare punctuation.
 */
export function queryTerms(needle: string) {
  const terms: string[] = [];
  for (const word of needle.split(/\s+/u))
    for (const part of slashDay(word) ? [word] : word.split(/\/+/u))
      if (/[\p{L}\p{N}]/u.test(part) && !terms.includes(part)) terms.push(part);
  return terms;
}

/** Words beyond this many run the names layer only: one mark byte holds them and two flags. */
export const MAX_TERMS = 6;
const TERM_BITS = 0x3f;
/** Ranked by the words layer, so the fuzzy layer skips it. */
const FOUND = 0x40;
/** Ranked by the names layer. */
const LITERAL = 0x80;

// Rank: layer tier, then history boost, then name length, then tree order.
// Smaller is better; every part fits a float64 exactly (5 + 4 + 12 + 32 bits).
const TIER = 2 ** 48;
const BOOST = 2 ** 44;
const LENGTH = 2 ** 32;
export const MAX_BOOST = 15;
/**
 * Tiers, best first. The whole query in a name takes 0-7: exact, prefix,
 * word boundary, anywhere, each first as typed (accents included) and then
 * read without accents. Then every word, in the name or with folders; then
 * joined words read apart; then dates read in any format; then corrections.
 */
export const TIER_WORDS_IN_NAME = 8;
export const TIER_WORDS_IN_PATH = 9;
export const TIER_SPLIT_IN_NAME = 10;
export const TIER_SPLIT_IN_PATH = 11;
export const TIER_DATES_IN_NAME = 12;
export const TIER_DATES_IN_PATH = 13;
export const TIER_FUZZY_IN_NAME = 14;
export const TIER_FUZZY_IN_PATH = 15;

export const Rank = {
  of: (tier: number, boost: number, length: number, order: number) =>
    tier * TIER +
    (MAX_BOOST - boost) * BOOST +
    Math.min(length, 4095) * LENGTH +
    order,
  tier: (rank: number) => Math.floor(rank / TIER),
  /** A compacted slot, or the layout's slot count plus the id for a delta entry. */
  order: (rank: number) => rank % LENGTH,
  /**
   * Tier of the whole query found at `at` in a name, preceded by character
   * code `before`; `plain` when it was found only without accents.
   */
  literalTier: (exact: boolean, at: number, before: number, plain: boolean) =>
    (exact ? 0 : at === 0 ? 1 : before < 128 && boundary[before] ? 2 : 3) * 2 +
    (plain ? 1 : 0),
} as const;

/** Whether `name` holds `term`; single characters match only at its start. */
const holdsAsTyped = (name: string, term: string) =>
  term.length === 1 ? name.startsWith(term) : name.includes(term);

/** Whether folded `name` holds folded `term`, as typed or without accents. */
export const nameHolds = (name: string, term: string) =>
  holdsAsTyped(name, term) || holdsAsTyped(plain(name), plain(term));

/** Word bits of `terms` held by folded `name`, as typed or without accents. */
export function termBits(name: string, terms: readonly string[]) {
  let bits = 0;
  const plainName = plain(name);
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i] ?? "";
    if (holdsAsTyped(name, term) || holdsAsTyped(plainName, plain(term)))
      bits |= 1 << i;
  }
  return bits;
}

/** The folded name in `slot`. */
export const slotName = (layout: SearchLayout, slot: number) =>
  layout.folded.toString(
    "utf8",
    layout.foldedStarts[slot] ?? 0,
    (layout.foldedStarts[slot + 1] ?? 1) - 1,
  );

/** Asked between batches of matches; true abandons the scan. */
export type Stopped = () => boolean;

/** Matches visited between checks of `stopped`. */
const CHECK_EVERY = 1024;

/** Names packed as UTF-8, each preceded by a NUL: entry i at `bytes[starts[i], starts[i + 1] - 1)`. */
type PackedText = { bytes: Buffer; starts: Int32Array };

/**
 * Call `visit(entry, at)` for each entry in `[first, end)` of `text` that
 * holds `pattern`, `at` being the match's byte offset. False when `stopped`
 * ended it early.
 */
function scanText(
  { bytes, starts }: PackedText,
  first: number,
  end: number,
  pattern: Buffer,
  prefixOnly: boolean,
  visit: (entry: number, at: number) => void,
  stopped: Stopped,
) {
  if (stopped()) return false;
  if (first >= end) return true;
  let budget = CHECK_EVERY;
  const shift = prefixOnly ? 1 : 0;
  const stop = starts[end] ?? bytes.length;
  // `indexOf` has no end bound: a view ending at the range keeps a miss from
  // scanning the rest of the drive, which this caller cannot see.
  const haystack = bytes.subarray(0, stop);
  let entry = first;
  let position = haystack.indexOf(pattern, (starts[first] ?? 0) - shift);
  while (position >= 0 && position + shift < stop) {
    const at = position + shift;
    // Gallop forward to the entry containing this match.
    if ((starts[entry + 1] ?? 0) <= at) {
      let step = 1;
      while (entry + step < end && (starts[entry + step + 1] ?? 0) <= at)
        step *= 2;
      let low = entry + (step >> 1);
      let high = Math.min(entry + step, end - 1);
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if ((starts[middle] ?? 0) <= at) low = middle;
        else high = middle - 1;
      }
      entry = low;
    }
    visit(entry, at);
    if (--budget === 0) {
      if (stopped()) return false;
      budget = CHECK_EVERY;
    }
    position = haystack.indexOf(pattern, (starts[entry + 1] ?? 0) - shift);
  }
  return true;
}

/** Call `visit(slot, at)` for each slot in `range` whose folded name holds `pattern`. */
const scan = (
  layout: SearchLayout,
  range: VisibleRange,
  pattern: Buffer,
  prefixOnly: boolean,
  visit: (slot: number, at: number) => void,
  stopped: Stopped,
) =>
  scanText(
    { bytes: layout.folded, starts: layout.foldedStarts },
    range.first,
    range.end,
    pattern,
    prefixOnly,
    visit,
    stopped,
  );

/** The first plain-name entry at or after `slot`. */
function plainEntry(layout: SearchLayout, slot: number) {
  const { plainSlot } = layout;
  let low = 0;
  let high = plainSlot.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((plainSlot[middle] ?? 0) < slot) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Call `visit(slot, at, entry)` for each slot in `range` whose plain name
 * (kept only where it differs from the folded one) holds `pattern`; `at`
 * is the byte offset in the plain names.
 */
const scanPlain = (
  layout: SearchLayout,
  range: VisibleRange,
  pattern: Buffer,
  prefixOnly: boolean,
  visit: (slot: number, at: number, entry: number) => void,
  stopped: Stopped,
) =>
  scanText(
    { bytes: layout.plain, starts: layout.plainStarts },
    plainEntry(layout, range.first),
    plainEntry(layout, range.end),
    pattern,
    prefixOnly,
    (entry, at) => visit(layout.plainSlot[entry] ?? 0, at, entry),
    stopped,
  );

const never: Stopped = () => false;

/**
 * `ranges` cut into at most `parts` groups of about equal name bytes, for
 * scan workers. A cut range's later piece takes as its outside the folder
 * above its first slot: every folder above a slot in the piece but before it
 * is above that first slot too, since subtrees are contiguous. (Not every
 * folder above the first slot is above the others, which `foldersAbove`
 * allows for.)
 */
export function splitRanges(
  layout: SearchLayout,
  ranges: readonly VisibleRange[],
  parts: number,
): VisibleRange[][] {
  const { foldedStarts, parentSlot } = layout;
  const bytesOf = (range: VisibleRange) =>
    (foldedStarts[range.end] ?? 0) - (foldedStarts[range.first] ?? 0);
  let total = 0;
  for (const range of ranges) total += bytesOf(range);
  const share = Math.max(1, Math.ceil(total / Math.max(1, parts)));
  const groups: VisibleRange[][] = [];
  let group: VisibleRange[] = [];
  let room = share;
  for (const whole of ranges) {
    let range = whole;
    while (range.first < range.end) {
      const bytes = bytesOf(range);
      if (bytes <= room || groups.length === parts - 1) {
        group.push(range);
        room -= bytes;
        break;
      }
      // The first slot whose name starts at or after the share runs out.
      const limit = (foldedStarts[range.first] ?? 0) + room;
      let low = range.first + 1;
      let high = range.end;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((foldedStarts[middle] ?? 0) < limit) low = middle + 1;
        else high = middle;
      }
      const cut = Math.min(low, range.end);
      if (cut > range.first) group.push({ ...range, end: cut });
      groups.push(group);
      group = [];
      room = share;
      range = {
        first: cut,
        end: range.end,
        outside: parentSlot[cut] ?? -1,
      };
    }
  }
  if (group.length) groups.push(group);
  return groups;
}

/** Visible names a scan saw: holding the whole query, and holding each query word. */
export type ScanCounts = { literal: number; terms: number[] };

/**
 * What a scan of the compacted names found: the best `limit` ranks, sorted,
 * how many matched, and the counts that decide whether the fuzzy layer runs.
 */
export type CompactRanks = {
  best: Float64Array;
  total: number;
  counts: ScanCounts;
};

export const ScanCounts = {
  none: (terms: number): ScanCounts => ({
    literal: 0,
    terms: new Array<number>(terms).fill(0),
  }),
  /** Add `from` into `into`. */
  add(into: ScanCounts, from: ScanCounts) {
    into.literal += from.literal;
    from.terms.forEach((count, term) => {
      into.terms[term] = (into.terms[term] ?? 0) + count;
    });
  },
} as const;

/** The best `limit` ranks, sorted, and how many were offered. */
export function collector(limit: number) {
  const best = new Float64Array(limit);
  let kept = 0;
  let total = 0;
  const insert = (rank: number) => {
    if (kept === limit && rank >= (best[limit - 1] ?? 0)) return;
    let index = kept < limit ? kept++ : limit - 1;
    while (index > 0 && (best[index - 1] ?? 0) > rank) {
      best[index] = best[index - 1] ?? 0;
      index--;
    }
    best[index] = rank;
  };
  return {
    add(rank: number) {
      total++;
      insert(rank);
    },
    /** Fold in ranks counted elsewhere: their best, and how many. */
    merge(ranks: CompactRanks) {
      total += ranks.total;
      for (const rank of ranks.best) insert(rank);
    },
    get total() {
      return total;
    },
    best: () => best.subarray(0, kept),
  };
}

/**
 * Scratch space for scans of one layout: a byte per slot for word marks, for
 * corrected-word marks and for history boosts. Scan workers share one, on
 * shared memory: each writes marks only in its own slots, and boosts are set
 * before they start and cleared after they all finish.
 */
export type ScanScratch = {
  marks: Uint8Array;
  corrected: Uint8Array;
  boosts: Uint8Array;
};

export const ScanScratch = {
  for: (layout: SearchLayout, shared = false): ScanScratch => {
    const bytes = (length: number): Uint8Array =>
      shared
        ? new Uint8Array(new SharedArrayBuffer(length))
        : new Uint8Array(length);
    return {
      marks: bytes(layout.slots),
      corrected: bytes(layout.slots),
      boosts: bytes(layout.slots),
    };
  },
  /** Put a plan's history boosts in place, before its scan starts. */
  setBoosts(scratch: ScanScratch, plan: ScanPlan) {
    for (let i = 0; i + 1 < plan.boosts.length; i += 2)
      scratch.boosts[plan.boosts[i] ?? 0] = plan.boosts[i + 1] ?? 0;
  },
  /** Take them away again, once every scan of the plan has finished. */
  clearBoosts(scratch: ScanScratch, plan: ScanPlan) {
    for (let i = 0; i < plan.boosts.length; i += 2)
      scratch.boosts[plan.boosts[i] ?? 0] = 0;
  },
} as const;

/**
 * Run the layers over the compacted names in `plan.ranges`, passing each
 * match's rank to `add` and counting visible names into `counts`. Removed
 * entries are skipped through `layout.dead`. The plan's boosts must already
 * be in `scratch` (ScanScratch.setBoosts). False when `stopped` ended it
 * early, with only some ranks passed.
 */
export function scanLayout(
  layout: SearchLayout,
  plan: ScanPlan,
  scratch: ScanScratch,
  add: (rank: number) => void,
  counts: ScanCounts,
  stopped: Stopped = never,
) {
  const { marks } = scratch;
  const { terms, after } = plan;
  const keep =
    after < 0
      ? add
      : (rank: number) => {
          if (rank > after) add(rank);
        };
  if (plan.fuzzyOnly)
    return (
      plan.fuzzy !== null &&
      fuzzy(layout, plan, plan.fuzzy, scratch, keep, stopped)
    );
  const marking = marksEarlierLayers(plan) || plan.fuzzy !== null;
  if (marking)
    for (const range of plan.ranges) marks.fill(0, range.first, range.end);
  return (
    names(layout, plan, scratch, keep, counts, stopped, marking) &&
    (!terms.length ||
      words(
        layout,
        plan.ranges,
        terms,
        marks,
        [TIER_WORDS_IN_NAME, TIER_WORDS_IN_PATH],
        scratch,
        keep,
        counts,
        stopped,
      )) &&
    // Joined words read apart, ahead of the second pass, which reuses the
    // same scratch byte after clearing it.
    (plan.split === null ||
      words(
        layout,
        plan.ranges,
        plan.split,
        scratch.corrected,
        [TIER_SPLIT_IN_NAME, TIER_SPLIT_IN_PATH],
        scratch,
        keep,
        null,
        stopped,
      )) &&
    (plan.fuzzy === null ||
      fuzzy(layout, plan, plan.fuzzy, scratch, keep, stopped))
  );
}

/** The folded name of `slot` has `needle`: at its start for one-character queries, else anywhere. */
function foldedHas(
  layout: SearchLayout,
  slot: number,
  needle: Buffer,
  prefixOnly: boolean,
) {
  const start = layout.foldedStarts[slot] ?? 0;
  const end = (layout.foldedStarts[slot + 1] ?? 1) - 1;
  return prefixOnly
    ? end - start >= needle.length &&
        needle.compare(layout.folded, start, start + needle.length) === 0
    : layout.folded.subarray(start, end).includes(needle);
}

/**
 * The whole query in a name: as typed, then without accents (the query's
 * plain form in names without accents, and in the plain form of names with
 * them). Each name counts once, at its best.
 */
function names(
  layout: SearchLayout,
  plan: ScanPlan,
  { boosts, marks }: ScanScratch,
  add: (rank: number) => void,
  counts: ScanCounts,
  stopped: Stopped,
  marking: boolean,
) {
  const { folded, foldedStarts, dead } = layout;
  const { needle } = plan;
  const plainNeedle = plain(needle);
  const accented = plainNeedle !== needle;
  const prefixOnly = needle.length === 1;
  const exact = Buffer.from(needle);
  const loose = Buffer.from(plainNeedle);
  const pattern = (bytes: Buffer) =>
    prefixOnly ? Buffer.concat([Buffer.from(SEPARATOR), bytes]) : bytes;
  /** Rank `slot` at the tier of a match at `at` in `bytes`, whose name starts at `start`. */
  const found = (
    slot: number,
    bytes: Buffer,
    start: number,
    nameBytes: number,
    query: Buffer,
    at: number,
    plainForm: boolean,
  ) => {
    if (dead[slot]) return;
    counts.literal++;
    if (marking) marks[slot] = (marks[slot] ?? 0) | LITERAL;
    const length =
      (foldedStarts[slot + 1] ?? 0) - (foldedStarts[slot] ?? 0) - 1;
    add(
      Rank.of(
        Rank.literalTier(
          nameBytes === query.length,
          at - start,
          bytes[at - 1] ?? 0,
          plainForm,
        ),
        boosts[slot] ?? 0,
        length,
        slot,
      ),
    );
  };
  const foldedLength = (slot: number) =>
    (foldedStarts[slot + 1] ?? 0) - (foldedStarts[slot] ?? 0) - 1;
  // Folding changes only letters: a query without any reads the same plain.
  const plainCanDiffer = /\p{L}/u.test(plainNeedle);
  for (const range of plan.ranges) {
    const asTyped = scan(
      layout,
      range,
      pattern(exact),
      prefixOnly,
      (slot, at) =>
        found(
          slot,
          folded,
          foldedStarts[slot] ?? 0,
          foldedLength(slot),
          exact,
          at,
          false,
        ),
      stopped,
    );
    if (!asTyped) return false;
    // An accented query, read plain, in names as they are.
    if (
      accented &&
      !scan(
        layout,
        range,
        pattern(loose),
        prefixOnly,
        (slot, at) => {
          if (foldedHas(layout, slot, exact, prefixOnly)) return;
          found(
            slot,
            folded,
            foldedStarts[slot] ?? 0,
            foldedLength(slot),
            loose,
            at,
            true,
          );
        },
        stopped,
      )
    )
      return false;
    if (!plainCanDiffer) continue;
    // The query read plain, in names that read differently plain.
    const withoutAccents = scanPlain(
      layout,
      range,
      pattern(loose),
      prefixOnly,
      (slot, at, entry) => {
        if (
          foldedHas(layout, slot, exact, prefixOnly) ||
          (accented && foldedHas(layout, slot, loose, prefixOnly))
        )
          return;
        const start = layout.plainStarts[entry] ?? 0;
        found(
          slot,
          layout.plain,
          start,
          (layout.plainStarts[entry + 1] ?? 0) - start - 1,
          loose,
          at,
          true,
        );
      },
      stopped,
    );
    if (!withoutAccents) return false;
  }
  return true;
}

/** Scan `range` for `term` as typed and without accents, calling `visit` once per match found. */
function scanWord(
  layout: SearchLayout,
  range: VisibleRange,
  term: string,
  visit: (slot: number) => void,
  stopped: Stopped,
) {
  const prefixOnly = term.length === 1;
  const plainTerm = plain(term);
  const pattern = (text: string) =>
    Buffer.from(prefixOnly ? SEPARATOR + text : text);
  return (
    (scan(layout, range, pattern(term), prefixOnly, visit, stopped) &&
      (plainTerm === term ||
        scan(layout, range, pattern(plainTerm), prefixOnly, visit, stopped)) &&
      // Folding changes only letters: a word without any reads the same plain.
      !/\p{L}/u.test(plainTerm)) ||
    scanPlain(layout, range, pattern(plainTerm), prefixOnly, visit, stopped)
  );
}

/**
 * Slots a words pass found, reused by every pass on this thread: broad words
 * find millions, and a fresh array each time would leave as much garbage.
 */
let candidates = new Int32Array(1 << 16);

const keepCandidate = (count: number, slot: number) => {
  if (count === candidates.length) {
    const grown = new Int32Array(candidates.length * 2);
    grown.set(candidates);
    candidates = grown;
  }
  candidates[count] = slot;
};

/**
 * The folders above `range`, each with the word bits it and every folder
 * above it hold (`bitsOf`). A candidate's walk up leaves the range at one of
 * these: any folder above a slot in the range but before it is above
 * `first` too. Folders removed since compaction hold nothing: a piece of a
 * split range can start inside one, and only removed names lie below it.
 */
function foldersAbove(
  layout: SearchLayout,
  range: VisibleRange,
  bitsOf: (slot: number) => number,
) {
  const chain: number[] = [];
  for (let slot = range.outside; slot > 0; slot = layout.parentSlot[slot] ?? -1)
    chain.push(slot);
  const above = new Map<number, number>();
  let carried = 0;
  for (let i = chain.length - 1; i >= 0; i--) {
    const slot = chain[i] ?? 0;
    if (!layout.dead[slot]) carried |= bitsOf(slot);
    above.set(slot, carried);
  }
  return above;
}

/**
 * Names holding every one of `terms`, or some with the rest in folders above,
 * with word bits kept in `bits` (the marks themselves for the query's words,
 * or another scratch array for another reading of them). Names an earlier
 * layer ranked are skipped, and those this ranks are flagged FOUND. Counts
 * visible names per word when given `counts`.
 */
function words(
  layout: SearchLayout,
  ranges: readonly VisibleRange[],
  terms: readonly string[],
  bits: Uint8Array,
  [inNameTier, inPathTier]: readonly [number, number],
  { boosts, marks }: ScanScratch,
  add: (rank: number) => void,
  counts: ScanCounts | null,
  stopped: Stopped,
) {
  const { foldedStarts, parentSlot, dead } = layout;
  const all = (1 << terms.length) - 1;
  const own = bits !== marks;
  for (const range of ranges) {
    if (own) bits.fill(0, range.first, range.end);
    const above = foldersAbove(layout, range, (slot) =>
      termBits(slotName(layout, slot), terms),
    );
    const outer = above.get(range.outside) ?? 0;
    let count = 0;
    for (let term = 0; term < terms.length; term++) {
      const bit = 1 << term;
      // Folders above the range show in every result's path, so they count as seen.
      if (counts && outer & bit)
        counts.terms[term] = (counts.terms[term] ?? 0) + 1;
      const finished = scanWord(
        layout,
        range,
        terms[term] ?? "",
        (slot) => {
          const held = bits[slot] ?? 0;
          if (counts && !dead[slot] && (held & bit) === 0)
            counts.terms[term] = (counts.terms[term] ?? 0) + 1;
          if (
            (held & TERM_BITS) === 0 &&
            ((marks[slot] ?? 0) & (LITERAL | FOUND)) === 0
          )
            keepCandidate(count++, slot);
          bits[slot] = held | bit;
        },
        stopped,
      );
      if (!finished) return false;
    }
    for (let at = 0; at < count; at++) {
      const slot = candidates[at] ?? 0;
      if (dead[slot] || (marks[slot] ?? 0) & (LITERAL | FOUND)) continue;
      const inName = (bits[slot] ?? 0) & all;
      let held = inName;
      let parent = parentSlot[slot] ?? -1;
      while (held !== all && parent >= range.first) {
        held |= (bits[parent] ?? 0) & all;
        parent = parentSlot[parent] ?? -1;
      }
      if (held !== all) held |= above.get(parent) ?? 0;
      if (held !== all) continue;
      marks[slot] = (marks[slot] ?? 0) | FOUND;
      const start = foldedStarts[slot] ?? 0;
      add(
        Rank.of(
          inName === all ? inNameTier : inPathTier,
          boosts[slot] ?? 0,
          (foldedStarts[slot + 1] ?? 0) - start - 1,
          slot,
        ),
      );
    }
  }
  return true;
}

/** Whether compacted `slot` is among the postings of any of `keys`. */
export function slotHolds(
  layout: SearchLayout,
  slot: number,
  keys: readonly number[],
) {
  const { postingStart, postingSlots } = layout;
  for (const key of keys) {
    const end = postingStart[key + 1] ?? 0;
    let low = postingStart[key] ?? 0;
    let high = end;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((postingSlots[middle] ?? 0) < slot) low = middle + 1;
      else high = middle;
    }
    if (low < end && postingSlots[low] === slot) return true;
  }
  return false;
}

/**
 * Names matching every word once misspelled words count as the words they
 * may have meant: a word holds where the name (or a folder above) holds it as
 * typed, or holds one of its corrections. Names an earlier layer ranked are
 * skipped, so every result here needed a correction.
 */
function fuzzy(
  layout: SearchLayout,
  plan: ScanPlan,
  { terms, keys, corrected: correctedWords }: NonNullable<ScanPlan["fuzzy"]>,
  { boosts, marks, corrected }: ScanScratch,
  add: (rank: number) => void,
  stopped: Stopped,
) {
  const { foldedStarts, parentSlot, dead, postingStart, postingSlots } = layout;
  const all = (1 << terms.length) - 1;
  // Word bits as typed, kept by the words pass (none for a one-word query,
  // whose only word as typed is a names-layer match), and as read otherwise.
  const typedMask = plan.terms.length ? TERM_BITS : 0;
  const typedAt = (slot: number) => (marks[slot] ?? 0) & typedMask & all;
  const otherAt = (slot: number) => (corrected[slot] ?? 0) & all;
  for (const range of plan.ranges) {
    if (stopped()) return false;
    corrected.fill(0, range.first, range.end);
    for (let term = 0; term < keys.length; term++) {
      const bit = 1 << term;
      for (const key of keys[term] ?? []) {
        const end = postingStart[key + 1] ?? 0;
        let low = postingStart[key] ?? 0;
        let high = end;
        while (low < high) {
          const middle = (low + high) >> 1;
          if ((postingSlots[middle] ?? 0) < range.first) low = middle + 1;
          else high = middle;
        }
        for (let at = low; at < end; at++) {
          const slot = postingSlots[at] ?? 0;
          if (slot >= range.end) break;
          corrected[slot] = (corrected[slot] ?? 0) | bit;
        }
      }
    }
    const typedAbove = foldersAbove(layout, range, (slot) =>
      termBits(slotName(layout, slot), terms),
    );
    const otherAbove = foldersAbove(layout, range, (slot) => {
      let bits = 0;
      for (let term = 0; term < keys.length; term++)
        if (slotHolds(layout, slot, keys[term] ?? [])) bits |= 1 << term;
      return bits;
    });
    for (let slot = range.first; slot < range.end; slot++) {
      let typed = typedAt(slot);
      let other = otherAt(slot);
      const inName = typed | other;
      if (inName === 0 || dead[slot] || (marks[slot] ?? 0) & (FOUND | LITERAL))
        continue;
      let parent = parentSlot[slot] ?? -1;
      while ((typed | other) !== all && parent >= range.first) {
        typed |= typedAt(parent);
        other |= otherAt(parent);
        parent = parentSlot[parent] ?? -1;
      }
      if ((typed | other) !== all) {
        typed |= typedAbove.get(parent) ?? 0;
        other |= otherAbove.get(parent) ?? 0;
      }
      if ((typed | other) !== all) continue;
      // A word met only through a typo correction makes it a fuzzy match;
      // through dates read another way, a date match.
      const fuzzyMatch = (other & ~typed & correctedWords) !== 0;
      const start = foldedStarts[slot] ?? 0;
      add(
        Rank.of(
          fuzzyMatch
            ? inName === all
              ? TIER_FUZZY_IN_NAME
              : TIER_FUZZY_IN_PATH
            : inName === all
              ? TIER_DATES_IN_NAME
              : TIER_DATES_IN_PATH,
          boosts[slot] ?? 0,
          (foldedStarts[slot + 1] ?? 0) - start - 1,
          slot,
        ),
      );
    }
  }
  return true;
}
