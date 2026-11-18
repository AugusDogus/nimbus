import { expect, test } from "bun:test";
import { SearchWords } from "./search-words";

test("keys ASCII names exactly as the general path does", () => {
  for (const name of [
    "useConfigTable.ts",
    "HomeownersPolicy_2025.pdf",
    "x9hmb2 S01E02 abc",
    "IMG_20240315_101500.jpg",
    "backupPhotosNightly",
    "ABCdef GHI aB",
    "report final 2024-03-15.pdf",
  ]) {
    // A trailing accented letter sends the name down the general path.
    const general = SearchWords.keysOf(`${name} é`).sort();
    expect({ name, keys: SearchWords.keysOf(name).sort() }).toEqual({
      name,
      keys: general,
    });
  }
  expect(SearchWords.keysOf("useConfigTable.ts").sort()).toEqual([
    "config",
    "table",
    "use",
    "useconfigtable",
  ]);
  // A day's month is found through the day's key, which it begins; a month
  // on its own has a key of its own.
  expect(SearchWords.keysOf("receipt 2024-03-15.pdf").sort()).toEqual([
    "D20240315",
    "pdf",
    "receipt",
  ]);
  expect(SearchWords.keysOf("statement 2024-03.pdf").sort()).toEqual([
    "M202403",
    "pdf",
    "statement",
  ]);
});

/** Optimal string alignment distance, computed in full. */
function reference(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  const at = (i: number, j: number) => d[i]?.[j] ?? Infinity;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      let value = Math.min(
        at(i - 1, j) + 1,
        at(i, j - 1) + 1,
        at(i - 1, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, at(i - 2, j - 2) + 1);
      const row = d[i];
      if (row) row[j] = value;
    }
  return at(a.length, b.length);
}

test("computes edit distance within the limit exactly, and only says beyond it", () => {
  let state = 7;
  const random = () =>
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const word = (length: number) =>
    Array.from({ length }, () => "abc"[Math.floor(random() * 3)]).join("");
  for (let run = 0; run < 3000; run++) {
    const a = word(1 + Math.floor(random() * 12));
    const b =
      random() < 0.5 ? word(1 + Math.floor(random() * 12)) : a.slice(1) + "a";
    for (const limit of [1, 2]) {
      const exact = reference(a, b);
      expect({
        a,
        b,
        limit,
        distance: SearchWords.distance(a, b, limit),
      }).toEqual({
        a,
        b,
        limit,
        distance: exact <= limit ? exact : limit + 1,
      });
    }
  }
});
