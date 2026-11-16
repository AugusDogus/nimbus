/**
 * The distinct words in an index's names, to turn a mistyped or abbreviated
 * query word into words that exist: `invioce` → `invoice`, `prjct` →
 * `project`. Words come from names split at anything that is not a letter and
 * at lower-to-upper case changes, so `useConfigTable` gives `config` too.
 *
 * Only the corrections come from here, never results: the fuzzy layer then
 * scans for them like any other word, within the ranges the caller may see.
 * The vocabulary spans the whole drive, so it is never shown to callers.
 */
import { foldName } from "./search-scan";

/** Shorter words are too ambiguous to correct, and too cheap to type wrong. */
const MIN_WORD = 3;
/** Corrections tried per query word; each costs one more scan. */
export const MAX_CORRECTIONS = 4;

/**
 * Words of a raw name, folded, at least three letters long. Short runs of
 * letters touching a digit are left out: they are pieces of ids and hashes
 * (`x9hmb2`, `S01E02`), not words anyone types.
 */
function wordsOf(raw: string) {
  const words: string[] = [];
  for (const match of raw.matchAll(/\p{L}+/gu)) {
    const run = match[0];
    const end = match.index + run.length;
    if (
      run.length <= 4 &&
      (/\p{N}/u.test(raw[match.index - 1] ?? "") ||
        /\p{N}/u.test(raw[end] ?? ""))
    )
      continue;
    for (const part of run.split(/(?<=\p{Ll})(?=\p{Lu})/u))
      if (part.length >= MIN_WORD) words.push(foldName(part));
  }
  return words;
}

/** Corrections are at least this long: shorter words are mostly fragments. */
const MIN_CORRECTION = 4;

/** Rows reused by `distance`; names are short, so these rarely grow. */
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

/**
 * How unlikely `word` is as what `term` meant; lower is better. One typo
 * beats an abbreviation, which beats two typos; a swap of neighbours counts
 * as barely a typo. Words in many names are likelier than a word in one
 * (names carry ids and hashes whose letters spell nothing).
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

export type SearchVocabulary = ReturnType<typeof create>;

function create() {
  /** Word → how many names hold it; a word leaves when its last name does. */
  const counts = new Map<string, number>();
  /** Words by length, so corrections look only at plausible lengths. */
  const byLength = new Map<number, Set<string>>();

  return {
    add(raw: string) {
      for (const word of wordsOf(raw)) {
        const count = counts.get(word) ?? 0;
        counts.set(word, count + 1);
        if (count === 0) {
          let words = byLength.get(word.length);
          if (!words) byLength.set(word.length, (words = new Set()));
          words.add(word);
        }
      }
    },

    remove(raw: string) {
      for (const word of wordsOf(raw)) {
        const count = counts.get(word) ?? 0;
        if (count > 1) counts.set(word, count - 1);
        else if (count === 1) {
          counts.delete(word);
          byLength.get(word.length)?.delete(word);
        }
      }
    },

    get size() {
      return counts.size;
    },

    /**
     * Words a folded query word may have meant, best first (see `score`): one
     * typo away (two for words of eight letters or more), or words it
     * abbreviates.
     * None when some name already holds the word: it is not misspelled, and
     * plain search finds it.
     */
    corrections(term: string): string[] {
      if (term.length < MIN_WORD || !/^\p{L}+$/u.test(term)) return [];
      for (const [length, words] of byLength)
        if (length >= term.length)
          for (const word of words) if (word.includes(term)) return [];
      const found: { word: string; score: number }[] = [];
      const typos = term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0;
      for (
        let length = term.length - typos;
        length <= term.length + typos;
        length++
      )
        for (const word of byLength.get(length) ?? []) {
          if (length < MIN_CORRECTION || !startsAlike(term, word)) continue;
          const away = distance(term, word, typos);
          if ((away === 1 || away === 2) && away <= typos)
            found.push({
              word,
              score: score(term, word, away, counts.get(word) ?? 1),
            });
        }
      if (term.length <= 6)
        for (let length = term.length + 1; length <= term.length * 3; length++)
          for (const word of byLength.get(length) ?? [])
            if (abbreviates(term, word))
              found.push({
                word,
                score: score(term, word, "abbreviation", counts.get(word) ?? 1),
              });
      found.sort((a, b) => a.score - b.score || (a.word < b.word ? -1 : 1));
      return found.slice(0, MAX_CORRECTIONS).map((item) => item.word);
    },
  };
}

export const SearchVocabulary = { create, wordsOf } as const;
