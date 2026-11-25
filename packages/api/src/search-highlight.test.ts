import { expect, test } from "bun:test";
import { createSearchIndex } from "./search-index";
import { SearchHighlight } from "./search-highlight";

test("marks each word in the name and in the folders shown beside it", () => {
  expect(
    SearchHighlight.forPath("Finance/2024/Invoice-2024-0042.pdf", [
      "2024",
      "invoice",
    ]),
  ).toEqual({
    name: [
      [0, 7],
      [8, 12],
    ],
    folder: [[8, 12]],
  });
});

test("marks single characters only where a name or folder starts", () => {
  expect(SearchHighlight.forPath("Music/Album/a song.mp3", ["a"])).toEqual({
    name: [[0, 1]],
    folder: [[6, 7]],
  });
});

test("marks the right letters when folding changes length", () => {
  expect(SearchHighlight.forPath("İstanbul notes.txt", ["notes"])).toEqual({
    name: [[9, 14]],
    folder: [],
  });
});

test("marks accented letters for words typed without accents, and the reverse", () => {
  expect(
    SearchHighlight.forPath("Recettes/Crème brûlée.md", ["creme", "brulee"]),
  ).toEqual({
    name: [
      [0, 5],
      [6, 12],
    ],
    folder: [],
  });
  expect(SearchHighlight.forPath("Housing/Straße 12.pdf", ["strasse"])).toEqual(
    { name: [[0, 6]], folder: [] },
  );
  expect(SearchHighlight.forPath("Menus/cafe.txt", ["café"])).toEqual({
    name: [[0, 4]],
    folder: [],
  });
  // Decomposed names keep no marks rather than misplaced ones.
  expect(SearchHighlight.forPath("Cre\u0300me.md", ["creme"])).toEqual({
    name: [],
    folder: [],
  });
});

test("marks a name holding the typed word as typed, not the parts a joined-word reading splits it into", () => {
  // "ce87b53e" also reads as joined words, "ce 87 b 53 e"; "invoice" holds "ce".
  const index = createSearchIndex();
  for (let file = 0; file < 3; file++)
    index.add(`layers/2024/invoice-ce87b53e-${file}.txt`, "file");
  index.add("layers/2024/report final.txt", "file");
  const search = (query: string) => {
    const answer = index.search({
      query,
      root: "",
      limit: 10,
      scope: { type: "all" },
      depth: "full",
      now: 1,
    });
    return new Map(
      answer.hits.map((hit) => [
        hit.path,
        SearchHighlight.forPath(hit.path, answer.terms, answer.split),
      ]),
    );
  };
  expect(
    search("2024 ce87b53e").get("layers/2024/invoice-ce87b53e-0.txt"),
  ).toEqual({
    name: [[8, 16]],
    folder: [[7, 11]],
  });
  // A name only the reading apart finds is marked by its parts.
  expect(
    search("2024 reportFinal").get("layers/2024/report final.txt"),
  ).toEqual({
    name: [
      [0, 6],
      [7, 12],
    ],
    folder: [[7, 11]],
  });
});
