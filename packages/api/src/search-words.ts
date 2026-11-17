/**
 * The word-to-name index behind the fuzzy layer: which names hold each word
 * of three or more letters, so a mistyped or abbreviated query word can be
 * corrected to words that exist (`invioce` → `invoice`, `prjct` → `project`)
 * and expanded straight to the names that hold them.
 *
 * Words come from raw names split at anything that is not a letter and at
 * lower-to-upper case changes (`useConfigTable` gives `useconfigtable`,
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
import { foldName } from "./search-scan";

/** Shorter words are too ambiguous to correct. */
const MIN_WORD = 3;
/** Corrections are at least this long: shorter words are mostly fragments. */
const MIN_CORRECTION = 4;
const FRAGMENT = "\0";
/** Visible names counted per candidate; enough to score, cheap to count. */
export const COUNT_CAP = 32;

/** Distinct index keys of a raw name: folded words, and fragments ending in NUL. */
function keysOf(raw: string): string[] {
  const keys = new Set<string>();
  for (const match of raw.matchAll(/\p{L}+/gu)) {
    const run = match[0];
    const end = match.index + run.length;
    if (
      run.length <= 4 &&
      (/\p{N}/u.test(raw[match.index - 1] ?? "") ||
        /\p{N}/u.test(raw[end] ?? ""))
    ) {
      if (run.length >= MIN_WORD) keys.add(foldName(run) + FRAGMENT);
      continue;
    }
    if (run.length >= MIN_WORD) keys.add(foldName(run));
    const parts = run.split(/(?<=\p{Ll})(?=\p{Lu})/u);
    if (parts.length > 1)
      for (const part of parts)
        if (part.length >= MIN_WORD) keys.add(foldName(part));
  }
  return [...keys];
}

/** The words of a raw name a correction can be, without fragments. */
const wordsOf = (raw: string) =>
  keysOf(raw).filter((key) => !key.endsWith(FRAGMENT));

/** Rows reused by `distance`; words are short, so these rarely grow. */
let rows = [new Int32Array(64), new Int32Array(64), new Int32Array(64)];

/**
 * Edit distance with adjacent transpositions (optimal string alignment),
 * or `limit + 1` once it must exceed `limit`.
 */
function distance(a: string, b: string, limit: number) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  if ((rows[0]?.length ?? 0) <= b.length)
    rows = rows.map(() => new Int32Array(b.length * 2 + 1));
  let [previous2, previous, current] = rows;
  if (!previous2 || !previous || !current) return limit + 1;
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      )
        value = Math.min(value, (previous2[j - 2] ?? 0) + 1);
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    [previous2, previous, current] = [previous, current, previous2];
  }
  return previous[b.length] ?? limit + 1;
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

/** Index of the first key in sorted `keys` that is not below `key`. */
function lowerBound(keys: readonly string[], key: string) {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((keys[middle] ?? "") < key) low = middle + 1;
    else high = middle;
  }
  return low;
}

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
  readonly keys: readonly string[];
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
  keys: [],
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

function create() {
  let base = emptyBase();
  /** Key → ids of names added since compaction holding it (removed ids stay; callers check liveness). */
  let delta = new Map<string, number[]>();

  const visibleCount = (key: string, visible: Visibility, cap: number) => {
    let count = 0;
    const index = lowerBound(base.keys, key);
    if (base.keys[index] === key) count += visible.baseCount(index, cap);
    for (const id of delta.get(key) ?? []) {
      if (count >= cap) break;
      if (visible.deltaVisible(id)) count++;
    }
    return count;
  };

  return {
    get base() {
      return base;
    },

    /** Index a name added since compaction. */
    add(id: number, raw: string) {
      for (const key of keysOf(raw)) {
        const ids = delta.get(key);
        if (ids) ids.push(id);
        else delta.set(key, [id]);
      }
    },

    /** Delta ids holding `key`, live or not. */
    deltaIds: (key: string): readonly number[] => delta.get(key) ?? [],

    /**
     * Fold the delta into new compacted postings. `oldSlotId` maps the old
     * layout's slots to ids, `slotOf` maps ids to new slots (-1 for gone).
     */
    compact(oldSlotId: Int32Array, slotOf: Int32Array) {
      const newSlot = (id: number) =>
        id >= 0 && id < slotOf.length ? (slotOf[id] ?? -1) : -1;
      // Both key lists are sorted: merge them rather than sort the union.
      const added = [...delta.keys()].sort();
      const keys: string[] = [];
      for (let a = 0, b = 0; a < base.keys.length || b < added.length;) {
        const fromBase = base.keys[a];
        const fromDelta = added[b];
        if (
          fromBase !== undefined &&
          (fromDelta === undefined || fromBase <= fromDelta)
        ) {
          if (fromBase === fromDelta) b++;
          keys.push(fromBase);
          a++;
        } else if (fromDelta !== undefined) {
          keys.push(fromDelta);
          b++;
        }
      }
      let bound = base.postingSlots.length;
      for (const ids of delta.values()) bound += ids.length;
      // Sized for every posting, live or not; the dead share is small.
      const slots = new Int32Array(new SharedArrayBuffer(bound * 4));
      const starts = new Int32Array(
        new SharedArrayBuffer((keys.length + 1) * 4),
      );
      let used = 0;
      let old = 0;
      const merged: number[] = [];
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index] ?? "";
        starts[index] = used;
        merged.length = 0;
        while (old < base.keys.length && (base.keys[old] ?? "") < key) old++;
        if (base.keys[old] === key) {
          // Compaction keeps surviving slots in the same order, so these stay sorted.
          for (
            let at = base.postingStart[old] ?? 0;
            at < (base.postingStart[old + 1] ?? 0);
            at++
          ) {
            const slot = newSlot(oldSlotId[base.postingSlots[at] ?? 0] ?? -1);
            if (slot >= 0) merged.push(slot);
          }
        }
        const fresh: number[] = [];
        for (const id of delta.get(key) ?? []) {
          const slot = newSlot(id);
          if (slot >= 0) fresh.push(slot);
        }
        fresh.sort((a, b) => a - b);
        let a = 0;
        let b = 0;
        while (a < merged.length || b < fresh.length) {
          const next =
            b >= fresh.length ||
            (a < merged.length && (merged[a] ?? 0) <= (fresh[b] ?? 0))
              ? merged[a++]
              : fresh[b++];
          slots[used++] = next ?? 0;
        }
      }
      starts[keys.length] = used;
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
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index] ?? "";
        if (key.endsWith(FRAGMENT) || starts[index] === starts[index + 1])
          continue;
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
        postingStart: starts,
        postingSlots,
        byFirst: freeze(first),
        bySecond: freeze(second),
      };
      delta = new Map();
    },

    /**
     * Words a folded query word may have meant, best first, among the words of
     * names the caller may see: one typo away (two for words of eight letters
     * or more), or words it abbreviates. At most `limit`.
     */
    corrections(term: string, visible: Visibility, limit: number): string[] {
      if (term.length < MIN_WORD || !/^\p{L}+$/u.test(term)) return [];
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
      const consider = (word: string) => {
        if (found.has(word)) return;
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
            consider(base.keys[index] ?? "");
        if (typo)
          for (const letter of letters)
            for (const index of base.bySecond.get(letter)?.get(length) ?? [])
              consider(base.keys[index] ?? "");
      }
      for (const key of delta.keys())
        if (!key.endsWith(FRAGMENT)) consider(key);
      return [...found]
        .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, limit)
        .map(([word]) => word);
    },

    /** The keys whose names hold `word`: itself, longer words starting with it, and their fragments. */
    expand(word: string): Expansion {
      const result: Expansion = { base: [], delta: [] };
      for (
        let index = lowerBound(base.keys, word);
        index < base.keys.length && (base.keys[index] ?? "").startsWith(word);
        index++
      )
        result.base.push(index);
      for (const key of delta.keys())
        if (key.startsWith(word)) result.delta.push(key);
      return result;
    },

    /** Whether delta entry `id` holds any of `keys`. */
    deltaHolds(id: number, keys: ReadonlySet<string>) {
      for (const key of keys) if (delta.get(key)?.includes(id)) return true;
      return false;
    },
  };
}

export type SearchWords = ReturnType<typeof create>;

export const SearchWords = { create, keysOf, wordsOf } as const;
