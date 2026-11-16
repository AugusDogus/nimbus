import { expect, test } from "bun:test";
import { parseDelimited } from "./delimited-text";

test("parses quoted fields, escaped quotes and embedded newlines", () => {
  expect(
    parseDelimited(
      'name,note\r\n"Doe, Jane","said ""hi""\nthen left"\nBob,\n',
      ",",
      10,
    ),
  ).toEqual({
    rows: [
      ["name", "note"],
      ["Doe, Jane", 'said "hi"\nthen left'],
      ["Bob", ""],
    ],
    truncated: false,
  });
});

test("splits tab-separated values", () => {
  expect(parseDelimited("a\tb\n1\t2", "\t", 10).rows).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("stops at the row limit and reports truncation", () => {
  expect(parseDelimited("1\n2\n3\n4", ",", 2)).toEqual({
    rows: [["1"], ["2"]],
    truncated: true,
  });
});

test("keeps an unterminated quote as literal text instead of failing", () => {
  expect(parseDelimited('a,"b\nc', ",", 10).rows).toEqual([["a", "b\nc"]]);
});
