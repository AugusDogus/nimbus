/**
 * The word-to-name index behind the fuzzy layer: which names hold each word
 * of three or more letters, so a mistyped or abbreviated query word can be
 * corrected to words that exist (`invioce` → `invoice`, `prjct` → `project`)
 * and expanded straight to the names that hold them.
 *
 * Words are folded and read without accents (search-text.ts), so `resume`
 * and `résumé` are one word. They come from raw names split at anything that
 * is not a letter and at lower-to-upper case changes (`useConfigTable` gives `useconfigtable`,
 * `use`, `config`, `table`). Short letter runs touching a digit are pieces
 * of ids and hashes (`x9hmb2`, `S01E02`); they are indexed as fragments,
 * keyed with a trailing NUL, so expansion still finds them but they are never
 * offered as corrections.
 *
 * Everything a caller sees is decided against the names it may read: a word
 * is a candidate only while some visible name holds it, and candidates are
 * scored by how many visible names do. The index spans the whole drive, but
 * nothing about names outside a caller's ranges changes what it gets.
 *
 * Compacted names are indexed by slot in shared memory (`postingStart`,
 * `postingSlots`, sorted per word), so scan workers can expand corrections
 * over their own slots. Names added since compaction are indexed by id on the
 * index's own thread; compaction merges them in without reading names again.
 */
import { datesIn, foldName, plain } from "./search-text";

/** A word as the index keys it: folded and without accents. */
const keyOf = (word: string) => plain(foldName(word));

/** Shorter words are too ambiguous to correct. */
const MIN_WORD = 3;
/** Corrections are at least this long: shorter words are mostly fragments. */
const MIN_CORRECTION = 4;
const FRAGMENT = "\0";
/**
 * Longer query words are not corrected: nobody mistypes a word this long
 * into one that exists, and comparing it with every word of about its
 * length would take long. A bound on the query alone, so what a caller gets
 * never depends on names it cannot read.
 */
const MAX_CORRECTED = 40;
/** Candidate words compared between checks of a search's stop signal. */
const STOP_CHECK_EVERY = 256;
/** Visible names counted per candidate; enough to score, cheap to count. */
export const COUNT_CAP = 32;

/** A date key (search-text.ts): `D` or `M` then digits; words are lowercase. */
const isDate = (key: string) => /^[DM]\d/.test(key);

/** Whether `key` can be offered as a correction: a word, not a fragment or a date. */
const isWord = (key: string) => !key.endsWith(FRAGMENT) && !isDate(key);

const isAsciiLetter = (code: number) =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isAsciiDigit = (code: number) => code >= 48 && code <= 57;
const isUpper = (code: number) => code >= 65 && code <= 90;

/** Keys of the ASCII letter run `raw[start, end)`, by the same rules as `keysOf`. */
function asciiRun(raw: string, start: number, end: number, keys: Set<string>) {
  const length = end - start;
  if (length < MIN_WORD) return;
  const run = raw.slice(start, end).toLowerCase();
  if (
    length <= 4 &&
    (isAsciiDigit(raw.charCodeAt(start - 1)) ||
      isAsciiDigit(raw.charCodeAt(end)))
  ) {
    keys.add(run + FRAGMENT);
    return;
  }
  keys.add(run);
  // camelCase: a lowercase letter followed by an uppercase one.
  let from = start;
  for (let at = start + 1; at <= end; at++) {
    if (
      at < end &&
      !(isUpper(raw.charCodeAt(at)) && !isUpper(raw.charCodeAt(at - 1)))
    )
      continue;
    if (from === start && at === end) return;
    if (at - from >= MIN_WORD) keys.add(raw.slice(from, at).toLowerCase());
    from = at;
  }
}

/** Distinct index keys of a raw name: folded words, fragments ending in NUL, and dates. */
function keysOf(raw: string): string[] {
  const keys = new Set<string>();
  // ASCII names, most of them: char codes instead of Unicode regexes.
  if (!/[^\u0000-\u007f]/.test(raw)) {
    let start = -1;
    for (let at = 0; at <= raw.length; at++) {
      if (at < raw.length && isAsciiLetter(raw.charCodeAt(at))) {
        if (start < 0) start = at;
      } else if (start >= 0) {
        asciiRun(raw, start, at, keys);
        start = -1;
      }
    }
  } else
    for (const match of raw.matchAll(/\p{L}+/gu)) {
      const run = match[0];
      const end = match.index + run.length;
      if (
        run.length <= 4 &&
        (/\p{N}/u.test(raw[match.index - 1] ?? "") ||
          /\p{N}/u.test(raw[end] ?? ""))
      ) {
        if (run.length >= MIN_WORD) keys.add(keyOf(run) + FRAGMENT);
        continue;
      }
      if (run.length >= MIN_WORD) keys.add(keyOf(run));
      const parts = run.split(/(?<=\p{Ll})(?=\p{Lu})/u);
      if (parts.length > 1)
        for (const part of parts)
          if (part.length >= MIN_WORD) keys.add(keyOf(part));
    }
  if (/\d/.test(raw)) for (const date of datesIn(raw)) keys.add(date);
  return [...keys];
}

/** The words of a raw name a correction can be, without fragments. */
const wordsOf = (raw: string) => keysOf(raw).filter(isWord);

/** Rows reused by `distance`; words are short, so these rarely grow. */
let rows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)];

/**
 * Edit distance with adjacent transpositions (optimal string alignment),
 * or `limit + 1` once it must exceed `limit`. Only cells within `limit` of
 * the diagonal can stay within it, so only those are computed: the cost
 * grows with the words' length, not its square.
 */
function distance(a: string, b: string, limit: number) {
  const far = limit + 1;
  if (Math.abs(a.length - b.length) > limit) return far;
  if ((rows[0]?.length ?? 0) <= b.length + 1)
    rows = rows.map(() => new Int32Array(b.length * 2 + 2));
  let [previous2, previous, current] = rows;
  if (!previous2 || !previous || !current) return far;
  for (let j = 0; j <= b.length + 1; j++) previous[j] = Math.min(j, far);
  for (let i = 1; i <= a.length; i++) {
    const from = Math.max(1, i - limit);
    const to = Math.min(b.length, i + limit);
    // The cells beside the band read as out of reach.
    current[from - 1] = from === 1 ? Math.min(i, far) : far;
    let best = far;
    for (let j = from; j <= to; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let value = Math.min(
        (previous[j] ?? far) + 1,
        (current[j - 1] ?? far) + 1,
        (previous[j - 1] ?? far) + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      )
        value = Math.min(value, (previous2[j - 2] ?? far) + 1);
      current[j] = Math.min(value, far);
      if (value < best) best = value;
    }
    current[to + 1] = far;
    if (best > limit) return far;
    [previous2, previous, current] = [previous, current, previous2];
  }
  return previous[b.length] ?? far;
}

/** Whether `b` is `a` with two neighbouring letters swapped: the commonest typo. */
function swapped(a: string, b: string) {
  if (a.length !== b.length) return false;
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  return (
    at + 1 < a.length &&
    a[at] === b[at + 1] &&
    a[at + 1] === b[at] &&
    a.slice(at + 2) === b.slice(at + 2)
  );
}

/** Whether an edit at the start could turn `a` into `b`: their first two letters overlap. */
const startsAlike = (a: string, b: string) =>
  a[0] === b[0] || a[0] === b[1] || a[1] === b[0] || a[1] === b[1];

/** Whether `short` is `word` with letters left out, keeping its first. */
function abbreviates(short: string, word: string) {
  if (short[0] !== word[0] || word.length <= short.length) return false;
  let at = 0;
  for (const char of word) if (char === short[at]) at++;
  return at === short.length;
}

/**
 * How unlikely `word` is as what `term` meant; lower is better. One typo
 * beats an abbreviation, which beats two typos; a swap of neighbours counts
 * as barely a typo. Words in many visible names are likelier than a word in
 * one. `names` counts only names the caller may read.
 */
function score(
  term: string,
  word: string,
  kind: 1 | 2 | "abbreviation",
  names: number,
) {
  const base =
    kind === "abbreviation"
      ? 150
      : kind === 1
        ? swapped(term, word)
          ? 70
          : 100
        : 200;
  return (
    base +
    Math.abs(word.length - term.length) +
    (names === 1 ? 60 : -Math.min(40, 8 * Math.log2(names)))
  );
}

/**
 * Sorted keys packed as UTF-8 in one buffer, key i at `bytes[start[i],
 * start[i + 1])`, in byte order. Hundreds of thousands of long-lived small
 * strings would pin the heap blocks around them, so keys are not kept as
 * strings.
 */
export type PackedKeys = {
  readonly bytes: Buffer;
  readonly start: Int32Array;
  readonly count: number;
};

const PackedKeys = {
  at: (keys: PackedKeys, index: number) =>
    keys.bytes.toString(
      "utf8",
      keys.start[index] ?? 0,
      keys.start[index + 1] ?? 0,
    ),
  /** Key `index` compared with `probe`: negative, zero or positive. */
  compare: (keys: PackedKeys, index: number, probe: Buffer) =>
    probe.compare(
      keys.bytes,
      keys.start[index] ?? 0,
      keys.start[index + 1] ?? 0,
    ) * -1,
  /** Index of the first key not below `probe`. */
  lowerBound(keys: PackedKeys, probe: Buffer) {
    let low = 0;
    let high = keys.count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (PackedKeys.compare(keys, middle, probe) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  },
  /** Whether key `index` begins with `probe`. */
  startsWith(keys: PackedKeys, index: number, probe: Buffer) {
    const from = keys.start[index] ?? 0;
    return (
      (keys.start[index + 1] ?? 0) - from >= probe.length &&
      probe.compare(keys.bytes, from, from + probe.length) === 0
    );
  },
} as const;

/** Index of the first slot in `slots[from, to)` that is not below `slot`. */
export function lowerSlot(
  slots: Int32Array,
  from: number,
  to: number,
  slot: number,
) {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((slots[middle] ?? 0) < slot) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Compacted postings: sorted keys, and for key i the slots `postingSlots[postingStart[i], postingStart[i + 1])`. */
export type BasePostings = {
  readonly keys: PackedKeys;
  readonly postingStart: Int32Array;
  readonly postingSlots: Int32Array;
  /**
   * Key indices of real words (not fragments) by first letter, and by second
   * letter, then by length: a typo or abbreviation keeps one of a word's
   * first two letters in one of those places, so only these are compared.
   */
  readonly byFirst: ReadonlyMap<string, ReadonlyMap<number, Int32Array>>;
  readonly bySecond: ReadonlyMap<string, ReadonlyMap<number, Int32Array>>;
};

const emptyBase = (): BasePostings => ({
  keys: { bytes: Buffer.alloc(0), start: new Int32Array(1), count: 0 },
  postingStart: new Int32Array(new SharedArrayBuffer(4)),
  postingSlots: new Int32Array(new SharedArrayBuffer(0)),
  byFirst: new Map(),
  bySecond: new Map(),
});

/** How a caller's visibility is asked about while choosing corrections. */
export type Visibility = {
  /** Visible live names holding base key `index`, up to `cap`. */
  baseCount: (index: number, cap: number) => number;
  /** Whether the added-since-compaction entry `id` is visible and live. */
  deltaVisible: (id: number) => boolean;
};

/** A correction expanded to the keys whose names hold it: itself, longer words starting with it, its fragments. */
export type Expansion = { base: number[]; delta: string[] };

/** A reusable Int32Array of at least `length`, so compaction leaves no garbage behind. */
function room(buffer: Int32Array<ArrayBuffer>, length: number) {
  return buffer.length >= length
    ? buffer
    : new Int32Array(Math.max(length, buffer.length * 2));
}

function create() {
  let base = emptyBase();
  // Names added since compaction, as a chain per key: key → its latest pair;
  // each pair holds an id and the key's previous pair (-1 ends the chain).
  // Removed ids stay; callers check liveness.
  let heads = new Map<string, number>();
  let pairId = new Int32Array(1 << 12);
  let pairNext = new Int32Array(1 << 12);
  let pairs = 0;
  // Merge buffers, kept between compactions.
  let kept = new Int32Array(1 << 12);
  let fresh = new Int32Array(1 << 12);

  const deltaIds = (key: string) => {
    const ids: number[] = [];
    for (let at = heads.get(key) ?? -1; at >= 0; at = pairNext[at] ?? -1)
      ids.push(pairId[at] ?? 0);
    return ids;
  };

  const visibleCount = (key: string, visible: Visibility, cap: number) => {
    let count = 0;
    const probe = Buffer.from(key);
    const index = PackedKeys.lowerBound(base.keys, probe);
    if (
      index < base.keys.count &&
      PackedKeys.compare(base.keys, index, probe) === 0
    )
      count += visible.baseCount(index, cap);
    for (
      let at = heads.get(key) ?? -1;
      at >= 0 && count < cap;
      at = pairNext[at] ?? -1
    )
      if (visible.deltaVisible(pairId[at] ?? 0)) count++;
    return count;
  };

  return {
    get base() {
      return base;
    },

    /** Index a name added since compaction. */
    add(id: number, raw: string) {
      for (const key of keysOf(raw)) {
        if (pairs === pairId.length) {
          const grownId = new Int32Array(pairs * 2);
          grownId.set(pairId);
          pairId = grownId;
          const grownNext = new Int32Array(pairs * 2);
          grownNext.set(pairNext);
          pairNext = grownNext;
        }
        pairId[pairs] = id;
        pairNext[pairs] = heads.get(key) ?? -1;
        heads.set(key, pairs++);
      }
    },

    /** Delta ids holding `key`, live or not. */
    deltaIds,

    /**
     * Fold the delta into new compacted postings. `oldSlotId` maps the old
     * layout's slots to ids, `slotOf` maps ids to new slots (-1 for gone).
     */
    compact(oldSlotId: Int32Array, slotOf: Int32Array) {
      const newSlot = (id: number) =>
        id >= 0 && id < slotOf.length ? (slotOf[id] ?? -1) : -1;
      // Both key lists are sorted by bytes: merge them rather than sort the union.
      const added = [...heads.keys()]
        .map((key) => ({ key, bytes: Buffer.from(key) }))
        .sort((a, b) => Buffer.compare(a.bytes, b.bytes));
      let byteBound = base.keys.bytes.length;
      for (const item of added) byteBound += item.bytes.length;
      const keyBytes = Buffer.alloc(byteBound);
      const keyStart = new Int32Array(base.keys.count + added.length + 1);
      // Sized for every posting, live or not; the dead share is small.
      const slots = new Int32Array(
        new SharedArrayBuffer((base.postingSlots.length + pairs) * 4),
      );
      const starts = new Int32Array(
        new SharedArrayBuffer((base.keys.count + added.length + 1) * 4),
      );
      let count = 0;
      let written = 0;
      let used = 0;
      for (let a = 0, b = 0; a < base.keys.count || b < added.length;) {
        const item = added[b];
        const order =
          a >= base.keys.count
            ? 1
            : item === undefined
              ? -1
              : PackedKeys.compare(base.keys, a, item.bytes);
        const old = order <= 0 ? a++ : -1;
        const key = order >= 0 && item ? item.key : null;
        if (order >= 0) b++;
        let keptCount = 0;
        if (old >= 0) {
          const from = base.postingStart[old] ?? 0;
          const to = base.postingStart[old + 1] ?? 0;
          kept = room(kept, to - from);
          // Compaction keeps surviving slots in the same order, so these stay sorted.
          for (let at = from; at < to; at++) {
            const slot = newSlot(oldSlotId[base.postingSlots[at] ?? 0] ?? -1);
            if (slot >= 0) kept[keptCount++] = slot;
          }
        }
        let freshCount = 0;
        for (
          let at = key === null ? -1 : (heads.get(key) ?? -1);
          at >= 0;
          at = pairNext[at] ?? -1
        ) {
          const slot = newSlot(pairId[at] ?? 0);
          if (slot < 0) continue;
          fresh = room(fresh, freshCount + 1);
          fresh[freshCount++] = slot;
        }
        // A key whose every name is gone leaves the index.
        if (keptCount + freshCount === 0) continue;
        fresh.subarray(0, freshCount).sort();
        starts[count] = used;
        keyStart[count] = written;
        written +=
          old >= 0
            ? base.keys.bytes.copy(
                keyBytes,
                written,
                base.keys.start[old] ?? 0,
                base.keys.start[old + 1] ?? 0,
              )
            : (item?.bytes.copy(keyBytes, written) ?? 0);
        count++;
        let x = 0;
        let y = 0;
        while (x < keptCount || y < freshCount) {
          slots[used++] =
            y >= freshCount ||
            (x < keptCount && (kept[x] ?? 0) <= (fresh[y] ?? 0))
              ? (kept[x++] ?? 0)
              : (fresh[y++] ?? 0);
        }
      }
      starts[count] = used;
      keyStart[count] = written;
      const keys: PackedKeys = {
        bytes: Buffer.from(keyBytes.subarray(0, written)),
        start: keyStart.slice(0, count + 1),
        count,
      };
      const postingStart = starts.subarray(0, count + 1);
      const postingSlots = slots.subarray(0, used);
      // Keys whose every name is gone take no part in corrections.
      const first = new Map<string, Map<number, number[]>>();
      const second = new Map<string, Map<number, number[]>>();
      const file = (
        buckets: Map<string, Map<number, number[]>>,
        letter: string,
        key: string,
        index: number,
      ) => {
        let byLength = buckets.get(letter);
        if (!byLength)
          buckets.set(letter, (byLength = new Map<number, number[]>()));
        let list = byLength.get(key.length);
        if (!list) byLength.set(key.length, (list = []));
        list.push(index);
      };
      for (let index = 0; index < count; index++) {
        const key = PackedKeys.at(keys, index);
        if (!isWord(key)) continue;
        file(first, key[0] ?? "", key, index);
        file(second, key[1] ?? "", key, index);
      }
      const freeze = (buckets: Map<string, Map<number, number[]>>) =>
        new Map(
          [...buckets].map(([letter, byLength]) => [
            letter,
            new Map(
              [...byLength].map(([length, list]) => [
                length,
                Int32Array.from(list),
              ]),
            ),
          ]),
        );
      base = {
        keys,
        postingStart,
        postingSlots,
        byFirst: freeze(first),
        bySecond: freeze(second),
      };
      heads = new Map();
      pairs = 0;
    },

    /**
     * Words a folded query word may have meant, best first, among the words of
     * names the caller may see: one typo away (two for words of eight letters
     * or more), or words it abbreviates. At most `limit`.
     */
    corrections(
      typed: string,
      visible: Visibility,
      limit: number,
      stopped: () => boolean = () => false,
    ): string[] {
      const term = plain(typed);
      if (
        term.length < MIN_WORD ||
        term.length > MAX_CORRECTED ||
        !/^\p{L}+$/u.test(term)
      )
        return [];
      const typos = term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0;
      const kindOf = (word: string): 1 | 2 | "abbreviation" | null => {
        if (word.length < MIN_CORRECTION || word.includes(term)) return null;
        if (
          Math.abs(word.length - term.length) <= typos &&
          startsAlike(term, word)
        ) {
          const away = distance(term, word, typos);
          if ((away === 1 || away === 2) && away <= typos) return away;
        }
        if (
          term.length <= 6 &&
          word.length <= term.length * 3 &&
          abbreviates(term, word)
        )
          return "abbreviation";
        return null;
      };
      const found = new Map<string, number>();
      // Checked every so many words; once stopped, the caller abandons the search.
      let budget = STOP_CHECK_EVERY;
      let halted = false;
      const consider = (word: string) => {
        if (--budget === 0) {
          budget = STOP_CHECK_EVERY;
          halted ||= stopped();
        }
        if (halted || found.has(word)) return;
        const kind = kindOf(word);
        if (kind === null) return;
        const names = visibleCount(word, visible, COUNT_CAP);
        if (names > 0) found.set(word, score(term, word, kind, names));
      };
      const letters = [...new Set([term[0] ?? "", term[1] ?? ""])];
      for (
        let length = term.length - typos;
        length <= term.length * 3;
        length++
      ) {
        // Abbreviations keep the first letter; typos one of the first two.
        const typo = length <= term.length + typos;
        for (const letter of typo ? letters : [term[0] ?? ""])
          for (const index of base.byFirst.get(letter)?.get(length) ?? [])
            consider(PackedKeys.at(base.keys, index));
        if (typo)
          for (const letter of letters)
            for (const index of base.bySecond.get(letter)?.get(length) ?? [])
              consider(PackedKeys.at(base.keys, index));
      }
      for (const key of heads.keys()) if (isWord(key)) consider(key);
      return [...found]
        .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, limit)
        .map(([word]) => word);
    },

    /** The keys whose names hold `word`: itself, longer words starting with it, and their fragments. */
    expand(typed: string): Expansion {
      const word = plain(typed);
      const result: Expansion = { base: [], delta: [] };
      const probe = Buffer.from(word);
      for (
        let index = PackedKeys.lowerBound(base.keys, probe);
        index < base.keys.count &&
        PackedKeys.startsWith(base.keys, index, probe);
        index++
      )
        result.base.push(index);
      for (const key of heads.keys())
        if (key.startsWith(word)) result.delta.push(key);
      return result;
    },
  };
}

export type SearchWords = ReturnType<typeof create>;

export const SearchWords = { create, keysOf, wordsOf, distance } as const;
