import { expect, test } from "bun:test";
import { SearchCursor } from "./search-cursor";

test("seals a cursor so it shows nothing of the index, and opens only an intact one", () => {
  const inner = "7-545417896922217-25-1794926691801-2166136261";
  const sealed = SearchCursor.seal(inner);
  expect(sealed).toMatch(/^[\w-]+$/);
  expect(sealed).not.toContain("545417896922217");
  expect(SearchCursor.seal(inner)).not.toBe(sealed);
  expect(SearchCursor.open(sealed)).toBe(inner);
  const altered = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}A`;
  expect(SearchCursor.open(altered)).toBeNull();
  expect(SearchCursor.open("not-a-cursor")).toBeNull();
});
