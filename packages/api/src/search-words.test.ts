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
  expect(SearchWords.keysOf("receipt 2024-03-15.pdf").sort()).toEqual([
    "D20240315",
    "M202403",
    "pdf",
    "receipt",
  ]);
});
