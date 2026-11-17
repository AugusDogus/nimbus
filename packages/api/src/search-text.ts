/**
 * How search reads text: names and queries are folded (NFC, lowercase) to
 * compare, then made plain to compare without accents, and read for dates and
 * for words joined into one.
 *
 * Plain form: each letter is decomposed and its combining marks dropped where
 * they are accents: after Latin and Greek letters always, after Cyrillic е only
 * the diaeresis (ё reads as е, but й stays apart from и, as in Russian
 * search). Elsewhere marks stay: Japanese voicing marks or Indic vowel signs
 * change the word, not its spelling. Letters that do not decompose but are
 * commonly typed without their stroke or ligature read as their plain
 * spelling: ø o, æ ae, œ oe, ß ss, ł l, đ and ð d, þ th, ħ h, ı i, and final ς
 * as σ.
 */

/** NFC plus lowercase: what both names and queries are compared as. */
export const foldName = (value: string) => value.normalize("NFC").toLowerCase();

/** Queries are typed text; control characters can never match a name. */
export const foldQuery = (value: string) =>
  foldName(value.trim()).replace(/[\u0000-\u001f\u007f]/g, "");

const SPELLED: Readonly<Record<string, string>> = {
  ø: "o",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ħ: "h",
  ı: "i",
  ς: "σ",
};

/** What a base letter does to the marks after it. */
type MarkRule = "drop" | "diaeresis" | "keep";

const ruleFor = (char: string): MarkRule =>
  /[\p{Script=Latin}\p{Script=Greek}]/u.test(char)
    ? "drop"
    : char === "е"
      ? "diaeresis"
      : "keep";

/**
 * The plain pieces of a folded text: for each of its code points, what it
 * reads as without accents (possibly empty, for a dropped mark) and where it
 * was. Marks follow the rule of the letter before them.
 */
function* pieces(folded: string) {
  let rule: MarkRule = "keep";
  let at = 0;
  for (const point of folded) {
    const start = at;
    at += point.length;
    let piece = "";
    for (const char of point.normalize("NFD")) {
      if (/\p{M}/u.test(char)) {
        if (rule === "drop" || (rule === "diaeresis" && char === "̈")) continue;
        piece += char;
        continue;
      }
      const spelled = SPELLED[char];
      rule = spelled !== undefined ? "drop" : ruleFor(char);
      piece += spelled ?? char;
    }
    yield { piece: piece.normalize("NFC"), start, end: at };
  }
}

/** A folded text without its accents. ASCII text is returned as it is. */
export function plain(folded: string) {
  // Most names are ASCII: nothing to do.
  if (!/[^\u0000-\u007f]/.test(folded)) return folded;
  let out = "";
  for (const { piece } of pieces(folded)) out += piece;
  return out;
}

/**
 * `text` folded and made plain, with where each character of the result came
 * from in `text`, so a match in the plain form can be marked on the original.
 * Null when folding would not keep positions (text that is not NFC).
 */
export function plainWithPositions(text: string) {
  if (text.normalize("NFC") !== text) return null;
  // Lowercased one code point at a time, remembering where each came from.
  let folded = "";
  const origin: [number, number][] = [];
  let at = 0;
  for (const point of text) {
    const lower = point.toLowerCase();
    for (let count = [...lower].length; count > 0; count--)
      origin.push([at, at + point.length]);
    folded += lower;
    at += point.length;
  }
  let out = "";
  const from: number[] = [];
  const to: number[] = [];
  let index = 0;
  for (const { piece } of pieces(folded)) {
    const [start, end] = origin[index++] ?? [0, 0];
    if (!piece) {
      // A dropped mark belongs to the character before it.
      if (to.length) to[to.length - 1] = Math.max(to[to.length - 1] ?? 0, end);
      continue;
    }
    for (let i = 0; i < piece.length; i++) {
      from.push(start);
      to.push(end);
    }
    out += piece;
  }
  return { plain: out, from, to };
}

/** Whether `value` reads the same without its accents. */
export const isPlain = (folded: string) => plain(folded) === folded;

/**
 * The words a query word joins with case changes, hyphens, underscores or
 * dots (`backupPhotos`, `user-profile-card`), folded; empty when it joins
 * fewer than two words with letters. `raw` is the word as typed, since
 * folding loses case.
 */
export function joinedWords(raw: string): string[] {
  const parts = raw
    .split(
      /[-_.]+|(?<=\p{Ll})(?=\p{Lu})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u,
    )
    .map(foldName)
    .filter((part) => /[\p{L}\p{N}]/u.test(part));
  // Words, not numbers: two parts with letters at least, so dates and
  // camera names (`2024-03`, `IMG_4821`) keep their own readings.
  const worded = parts.filter((part) => /\p{L}/u.test(part)).length;
  return worded > 1 ? [...new Set(parts)] : [];
}

/**
 * Dates, as index keys: `D` and the date as YYYYMMDD, and `M` and the month
 * as YYYYMM. The prefixes keep them apart from words, which are letters.
 */
const dayKey = (year: number, month: number, day: number) =>
  `D${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
const monthKey = (year: number, month: number) =>
  `M${year}${String(month).padStart(2, "0")}`;

const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const validDay = (year: number, month: number, day: number) =>
  year >= 1900 &&
  year <= 2099 &&
  month >= 1 &&
  month <= 12 &&
  day >= 1 &&
  day <= (DAYS[month - 1] ?? 0);

/** Day-first and month-first readings of `a-b-year`, where valid. */
function bothOrders(a: number, b: number, year: number) {
  const keys: string[] = [];
  if (validDay(year, b, a)) keys.push(dayKey(year, b, a));
  if (a !== b && validDay(year, a, b)) keys.push(dayKey(year, a, b));
  return keys;
}

const number = (value: string | undefined) => Number(value ?? "");

/**
 * Dates written in a name, as keys: 2024-03-15, 2024.03.15, 2024_03_15,
 * 2024 03 15 and 20240315 give a day and its month; 15-03-2024 and
 * 03/15/2024 give every valid reading (day first, month first); 2024-03 gives
 * a month. Digits must not run on into other digits.
 */
export function datesIn(name: string): string[] {
  const keys = new Set<string>();
  const sep = "[-_. /]";
  const ymd = new RegExp(
    `(?<!\\d)((?:19|20)\\d{2})(${sep}?)(\\d{2})\\2(\\d{2})(?!\\d)`,
    "g",
  );
  for (const match of name.matchAll(ymd)) {
    const [year, month, day] = [
      number(match[1]),
      number(match[3]),
      number(match[4]),
    ];
    if (validDay(year, month, day)) {
      keys.add(dayKey(year, month, day));
      keys.add(monthKey(year, month));
    }
  }
  const dmy = new RegExp(
    `(?<!\\d)(\\d{1,2})(${sep})(\\d{1,2})\\2((?:19|20)\\d{2})(?!\\d)`,
    "g",
  );
  for (const match of name.matchAll(dmy)) {
    const year = number(match[4]);
    for (const key of bothOrders(number(match[1]), number(match[3]), year)) {
      keys.add(key);
      keys.add(`M${key.slice(1, 7)}`);
    }
  }
  const ym = new RegExp(
    `(?<!\\d)((?:19|20)\\d{2})${sep}(\\d{2})(?![-_. /]?\\d)`,
    "g",
  );
  for (const match of name.matchAll(ym)) {
    const [year, month] = [number(match[1]), number(match[2])];
    if (month >= 1 && month <= 12) keys.add(monthKey(year, month));
  }
  return [...keys];
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * The date keys a query word stands for, when it is a date: the same forms
 * as `datesIn` (a whole word, so `2024` alone is not a date). Empty otherwise.
 */
export function queryDates(word: string): string[] {
  if (!/^\d[\d\-_. /]*\d$/.test(word)) return [];
  const keys = datesIn(word).filter(
    (key) => key.startsWith("D") || !/^\d{8}$/.test(word),
  );
  // A day query asks for that day; its month key is only for month queries.
  const days = keys.filter((key) => key.startsWith("D"));
  return days.length ? days : keys;
}

/** The month a query word names, as a number 1-12, or null. Three letters or more. */
export function monthNamed(word: string) {
  if (word.length < 3) return null;
  const index = MONTHS.findIndex((month) => month.startsWith(word));
  return index < 0 ? null : index + 1;
}

export const SearchText = {
  foldName,
  foldQuery,
  plain,
  plainWithPositions,
  isPlain,
  joinedWords,
  datesIn,
  queryDates,
  monthNamed,
} as const;

/** Ways a date key is commonly written, for marking it in names. */
export function dateSpellings(key: string): string[] {
  const year = key.slice(1, 5);
  const month = key.slice(5, 7);
  if (key.startsWith("M"))
    return [
      `${year}-${month}`,
      `${year}.${month}`,
      `${year}_${month}`,
      `${month}-${year}`,
    ];
  const day = key.slice(7, 9);
  return [
    `${year}-${month}-${day}`,
    `${year}.${month}.${day}`,
    `${year}_${month}_${day}`,
    `${year} ${month} ${day}`,
    `${year}${month}${day}`,
    `${day}-${month}-${year}`,
    `${day}.${month}.${year}`,
    `${day}/${month}/${year}`,
    `${month}-${day}-${year}`,
    `${month}/${day}/${year}`,
  ];
}
