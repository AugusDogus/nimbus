import { expect, test } from "bun:test";
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

test("marks nothing rather than the wrong letters when folding changes length", () => {
  expect(SearchHighlight.forPath("İstanbul notes.txt", ["notes"])).toEqual({
    name: [],
    folder: [],
  });
});
