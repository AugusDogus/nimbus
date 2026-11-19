/**
 * `Content-Disposition` for a file Nimbus sends, so every client saves it under its own name.
 *
 * RFC 6266 section 4.3 and appendix D: `filename*` carries the exact name, in RFC 8187's
 * encoding, and a plain `filename` first gives clients that cannot read `filename*` an ASCII
 * approximation. A client that understands `filename*` uses it whatever its position.
 *
 * `filename*` escapes every byte outside RFC 8187's `attr-char`. `encodeURIComponent` alone
 * leaves `'`, `(`, `)` and `*` as they are, which makes the value invalid; Chrome then ignores
 * it and names the download after the URL, which for a public link is its token.
 *
 * The fallback keeps printable ASCII, folds accented letters to their base letter (é to e), and
 * writes `_` for everything else, including `"`, `\` and `%`, which RFC 6266 advises against in
 * it. Neither parameter can carry a control character, so a name never ends the header.
 */
export type DispositionType = "inline" | "attachment";

/** Every byte of `name`'s UTF-8 outside RFC 8187 attr-char, percent-encoded. */
const extendedValue = (name: string) =>
  encodeURIComponent(name).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );

/** `name` in printable ASCII, safe inside a quoted string. */
const asciiFallback = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]|["\\%]/gu, "_");

export const ContentDisposition = {
  header(type: DispositionType, filename: string) {
    // A lone surrogate has no UTF-8 encoding; `encodeURIComponent` would throw on it.
    const name = filename.toWellFormed();
    return `${type}; filename="${asciiFallback(name)}"; filename*=UTF-8''${extendedValue(name)}`;
  },
} as const;
