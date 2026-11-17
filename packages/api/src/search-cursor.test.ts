import { expect, test } from "bun:test";
import { SearchCursor } from "./search-cursor";

test("seals a cursor so it shows nothing of the index, and opens only an intact one, for the caller it was sealed for", () => {
  const inner = "7-545417896922217-25-1794926691801-2166136261";
  const sealed = SearchCursor.seal(inner, "user-1");
  expect(sealed).toMatch(/^[\w-]+$/);
  expect(sealed).not.toContain("545417896922217");
  expect(SearchCursor.seal(inner, "user-1")).not.toBe(sealed);
  expect(SearchCursor.open(sealed, "user-1")).toBe(inner);
  expect(SearchCursor.open(sealed, "user-2")).toBeNull();
  const altered = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}A`;
  expect(SearchCursor.open(altered, "user-1")).toBeNull();
  expect(SearchCursor.open("not-a-cursor", "user-1")).toBeNull();
});
