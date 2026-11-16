import { expect, test } from "bun:test";
import { SearchVocabulary } from "./search-vocabulary";

test("splits names into folded words at non-letters and camel case", () => {
  expect(
    SearchVocabulary.wordsOf("useConfigTable-v2 Résumé_final.PDF"),
  ).toEqual(["use", "config", "table", "résumé", "final", "pdf"]);
});

test("corrects typos, transpositions and abbreviations, closest first", () => {
  const vocabulary = SearchVocabulary.create();
  for (const name of [
    "invoice.pdf",
    "invoices",
    "Project plan.docx",
    "thumbnail.png",
  ])
    vocabulary.add(name);
  // "invoices" is two edits away; scanning for "invoice" finds it anyway.
  expect(vocabulary.corrections("invioce")).toEqual(["invoice"]);
  expect(vocabulary.corrections("prjct")).toEqual(["project"]);
  expect(vocabulary.corrections("thmb")).toEqual(["thumbnail"]);
  // Words that hold the query are plain matches, not corrections.
  expect(vocabulary.corrections("invoice")).toEqual([]);
  expect(vocabulary.corrections("2024")).toEqual([]);
});

test("forgets a word when its last name goes", () => {
  const vocabulary = SearchVocabulary.create();
  vocabulary.add("budget.xlsx");
  vocabulary.add("budget-2.xlsx");
  vocabulary.remove("budget.xlsx");
  expect(vocabulary.corrections("budgte")).toEqual(["budget"]);
  vocabulary.remove("budget-2.xlsx");
  expect(vocabulary.corrections("budgte")).toEqual([]);
  expect(vocabulary.size).toBe(0);
});

test("leaves out short letter runs that are pieces of ids", () => {
  expect(
    SearchVocabulary.wordsOf("x9hmb2 S01E02 IMG_20240101 report2024.jpg"),
  ).toEqual(["img", "report", "jpg"]);
});
