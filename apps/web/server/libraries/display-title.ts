import type { LibraryItemKind } from "../db/library-schema";

/**
 * Display text for a library item, derived from its file name as a convenience for clients:
 * the extension removed, a short leading sequence number removed, whole calendar dates at the
 * start or end removed, separators turned into spaces, and an all-uppercase name put in
 * sentence case with known acronyms kept. Clients also get the real file name. The rules and
 * examples are in docs/library-api/README.md.
 */

const maxLength = 160;
const acronyms = new Set(["PDF", "FAQ", "USB", "GPS", "DIY", "DVD"]);
/** A final extension: a dot, then 1 to 10 letters or digits, after a non-empty stem. */
const extension = /(?<=.)\.[\p{L}\p{N}]{1,10}$/u;
// Controls and invisible format characters, such as bidirectional marks that reorder text.
const controls = /[\p{Cc}\p{Cf}]/gu;
/**
 * A short leading sequence number, as in `01 Getting started` or `3 - Follow up`. A zero-padded
 * number of 2 or 3 digits goes before any separator when letters come later. An unpadded number
 * of 1 to 3 digits goes only before a spaced dash, or a dot or parenthesis followed by a letter,
 * so `12 days`, `101 questions`, `3-step` and `1.5 cups` stay. A number that is the whole title
 * stays too.
 */
const sequenceNumber =
  /^(?:0\d{1,2}(?:\s*[-–.)]\s*|[\s_]+)(?=.*\p{L})|[1-9]\d{0,2}(?:\s+[-–]\s+|[.)]\s*)(?=\p{L}))/u;
const leadingDate = /^(\d{4})([-_]?)(\d{2})\2(\d{2})(?=$|[\s_-])/;
const trailingDate = /(?<=^|[\s_-])(\d{4})([-_]?)(\d{2})\2(\d{2})$/;
const edgePunctuation = /^[\s.,;:!_-]+|[\s.,;:!_-]+$/g;

function isCalendarDate(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

/** `text` without whole calendar dates at its start and end, however many there are. */
function withoutEdgeDates(text: string) {
  let current = text;
  for (const pattern of [leadingDate, trailingDate])
    for (;;) {
      const trimmed = current.replace(edgePunctuation, "");
      const match = pattern.exec(trimmed);
      if (
        !match ||
        !isCalendarDate(Number(match[1]), Number(match[3]), Number(match[4]))
      )
        break;
      current = trimmed.replace(pattern, " ");
    }
  return current;
}

/** Sentence case for an all-uppercase phrase, keeping known acronyms and words with digits. */
function casing(text: string) {
  if (!/\p{L}/u.test(text) || /\p{Ll}/u.test(text)) return text;
  const words = text.split(" ");
  const [only] = words;
  // A lone short uppercase word may be an acronym nobody listed.
  if (words.length === 1 && only !== undefined && [...only].length <= 5)
    return text;
  return words
    .map((word, index) => {
      if (acronyms.has(word) || /\d/.test(word)) return word;
      const lower = word.toLocaleLowerCase("en");
      if (index > 0) return lower;
      const [first = "", ...rest] = lower;
      return first.toLocaleUpperCase("en") + rest.join("");
    })
    .join(" ");
}

/** At most `maxLength` user-perceived characters, cut at a grapheme boundary. */
function bounded(text: string) {
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
  ];
  return graphemes.length <= maxLength
    ? text
    : graphemes
        .slice(0, maxLength)
        .map((part) => part.segment)
        .join("")
        .trimEnd();
}

/** Sequence numbers, dates, separators and casing cleaned from `text`; "" when nothing is left. */
function clean(text: string) {
  const plain = text.normalize("NFC").replace(controls, "").trim();
  const spaced = withoutEdgeDates(plain.replace(sequenceNumber, ""))
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(edgePunctuation, "");
  return /[\p{L}\p{N}]/u.test(spaced) ? bounded(casing(spaced)) : "";
}

const fallbacks: Record<LibraryItemKind, string> = {
  video: "Video",
  audio: "Audio",
  image: "Image",
  document: "Document",
  other: "File",
};

export const DisplayTitle = {
  clean,
  /** The title for the file `name` of kind `kind` whose catalog id is `id`. */
  fromFileName(name: string, kind: LibraryItemKind, id: string) {
    return (
      clean(name.replace(extension, "")) || `${fallbacks[kind]} ${id.slice(-6)}`
    );
  },
  /** A folder name as a collection label, or null when nothing readable is left. */
  collection: (folderName: string) => clean(folderName) || null,
} as const;
