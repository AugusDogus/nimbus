/**
 * The compacted half of a search: scans of an index layout's packed names,
 * using only slot-indexed arrays that compaction builds once and never
 * changes, plus the `dead` marks of entries removed since. It reads nothing
 * else, so a scan worker can run it over its share of the slots while the
 * index keeps changing on its own thread.
 *
 * Two layers run here, each over only the ranges the caller may see:
 * - names: the whole query as a substring of a name, ranked exact, prefix,
 *   word boundary, then anywhere;
 * - words: every word of the query in the name or in a folder above it, at
 *   least one in the name. One scan per word marks the slots whose names hold
 *   it; a candidate's folders are checked through those marks by walking up
 *   the tree, so full paths are never built.
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
  ranges: readonly VisibleRange[];
  /** Flat [slot, boost, slot, boost, ...] pairs from the caller's history. */
  boosts: readonly number[];
};

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

/** Words beyond this many run the names layer only: one mark byte holds them. */
export const MAX_TERMS = 7;
const LITERAL = 0x80;

// Rank: layer tier, then history boost, then name length, then tree order.
// Smaller is better; every part fits a float64 exactly (5 + 4 + 12 + 32 bits).
const TIER = 2 ** 48;
const BOOST = 2 ** 44;
const LENGTH = 2 ** 32;
export const MAX_BOOST = 15;
export const TIER_WORDS_IN_NAME = 4;
export const TIER_WORDS_IN_PATH = 5;

export const Rank = {
  of: (tier: number, boost: number, length: number, order: number) =>
    tier * TIER +
    (MAX_BOOST - boost) * BOOST +
    Math.min(length, 4095) * LENGTH +
    order,
  tier: (rank: number) => Math.floor(rank / TIER),
  /** A compacted slot, or the layout's slot count plus the id for a delta entry. */
  order: (rank: number) => rank % LENGTH,
  /** Literal tier of a match at `at` in a name, preceded by character code `before`. */
  literalTier: (exact: boolean, at: number, before: number) =>
    exact ? 0 : at === 0 ? 1 : before < 128 && boundary[before] ? 2 : 3,
} as const;

/** Whether `name` holds `term`; single characters match only at its start. */
export const nameHolds = (name: string, term: string) =>
  term.length === 1 ? name.startsWith(term) : name.includes(term);

/** Word bits of `terms` held by `name`. */
export function termBits(name: string, terms: readonly string[]) {
  let bits = 0;
  for (let i = 0; i < terms.length; i++)
    if (nameHolds(name, terms[i] ?? "")) bits |= 1 << i;
  return bits;
}

/** The folded name in `slot`. */
export const slotName = (layout: SearchLayout, slot: number) =>
  layout.folded.toString(
    "utf8",
    layout.foldedStarts[slot] ?? 0,
    (layout.foldedStarts[slot + 1] ?? 1) - 1,
  );

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

/** Scratch space for scans of one layout: a byte per slot for word marks and boosts. */
export type ScanScratch = { marks: Uint8Array; boosts: Uint8Array };

export const ScanScratch = {
  for: (layout: SearchLayout): ScanScratch => ({
    marks: new Uint8Array(layout.slots),
    boosts: new Uint8Array(layout.slots),
  }),
} as const;

/**
 * Run both layers over the compacted names in `plan.ranges`, passing each
 * match's rank to `add`. Removed entries are skipped through `layout.dead`.
 */
export function scanLayout(
  layout: SearchLayout,
  plan: ScanPlan,
  scratch: ScanScratch,
  add: (rank: number) => void,
) {
  const { boosts, marks } = scratch;
  const { terms } = plan;
  for (let i = 0; i + 1 < plan.boosts.length; i += 2)
    boosts[plan.boosts[i] ?? 0] = plan.boosts[i + 1] ?? 0;
  try {
    if (terms.length)
      for (const range of plan.ranges) marks.fill(0, range.first, range.end);
    names(layout, plan, scratch, add);
    if (terms.length) words(layout, plan, scratch, add);
  } finally {
    for (let i = 0; i < plan.boosts.length; i += 2)
      boosts[plan.boosts[i] ?? 0] = 0;
  }
}

function names(
  layout: SearchLayout,
  plan: ScanPlan,
  { boosts, marks }: ScanScratch,
  add: (rank: number) => void,
) {
  const { folded, foldedStarts, dead } = layout;
  const { needle } = plan;
  const marking = plan.terms.length > 0;
  const prefixOnly = needle.length === 1;
  const pattern = Buffer.from(prefixOnly ? SEPARATOR + needle : needle);
  const needleBytes = pattern.length - (prefixOnly ? 1 : 0);
  for (const range of plan.ranges)
    scan(layout, range, pattern, prefixOnly, (slot, at) => {
      if (dead[slot]) return;
      const start = foldedStarts[slot] ?? 0;
      const length = (foldedStarts[slot + 1] ?? 0) - start - 1;
      if (marking) marks[slot] = (marks[slot] ?? 0) | LITERAL;
      add(
        Rank.of(
          Rank.literalTier(
            length === needleBytes,
            at - start,
            folded[at - 1] ?? 0,
          ),
          boosts[slot] ?? 0,
          length,
          slot,
        ),
      );
    });
}

/** Names holding every word, or some with the rest in folders above. Literal matches are skipped. */
function words(
  layout: SearchLayout,
  plan: ScanPlan,
  { boosts, marks }: ScanScratch,
  add: (rank: number) => void,
) {
  const { foldedStarts, parentSlot, dead } = layout;
  const { terms } = plan;
  const all = (1 << terms.length) - 1;
  for (const range of plan.ranges) {
    let outer = 0;
    for (let slot = range.outside; slot > 0; slot = parentSlot[slot] ?? -1)
      outer |= termBits(slotName(layout, slot), terms);
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
    for (const slot of candidates) {
      if (dead[slot]) continue;
      const inName = (marks[slot] ?? 0) & all;
      let bits = inName | outer;
      for (
        let parent = parentSlot[slot] ?? -1;
        bits !== all && parent >= range.first;
        parent = parentSlot[parent] ?? -1
      )
        bits |= (marks[parent] ?? 0) & all;
      if (bits !== all) continue;
      const start = foldedStarts[slot] ?? 0;
      add(
        Rank.of(
          inName === all ? TIER_WORDS_IN_NAME : TIER_WORDS_IN_PATH,
          boosts[slot] ?? 0,
          (foldedStarts[slot + 1] ?? 0) - start - 1,
          slot,
        ),
      );
    }
  }
}
