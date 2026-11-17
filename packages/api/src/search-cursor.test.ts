import { expect, test } from "bun:test";
import { MAX_SEALED_CURSOR, SearchCursor } from "./search-cursor";

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

test("seals every cursor to the same length, so its size tells nothing", () => {
  const digest = "0123456789abcdef";
  const shortest = `1-0-0-0-${digest}-${digest}-0-${digest}`;
  const longest = [
    "9".repeat(15),
    "9".repeat(16),
    "9".repeat(9),
    "9".repeat(15),
    digest,
    digest,
    "99",
    digest,
  ].join("-");
  const sealed = SearchCursor.seal(shortest, "u");
  expect(SearchCursor.seal(longest, "u")).toHaveLength(sealed.length);
  expect(SearchCursor.open(sealed, "u")).toBe(shortest);
  expect(SearchCursor.open(SearchCursor.seal(longest, "u"), "u")).toBe(longest);
  expect(sealed.length).toBeLessThanOrEqual(MAX_SEALED_CURSOR);
});
