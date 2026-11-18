import { describe, expect, it } from "bun:test";
import { SearchPages, type PageLike } from "./search-pages";

type Page = PageLike<{ path: string }>;

const page = (
  paths: string[],
  next: string | null,
  restarted = false,
): Page => ({
  entries: paths.map((path) => ({ path })),
  next,
  restarted,
});

/** A server whose pages continue from cursors, with scripted answers. */
const server = (answers: Record<string, Page>) => {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (cursor: string) => {
      asked.push(cursor);
      const answer = answers[cursor];
      if (!answer) throw new Error(`No page for ${cursor}`);
      return answer;
    },
  };
};

const paths = (pages: readonly Page[]) =>
  SearchPages.entries(pages).map((entry) => entry.path);

describe("search pages", () => {
  const first = page(["a", "b"], "c1");

  it("appends a continued page", async () => {
    const { fetch } = server({ c1: page(["c", "d"], "c2") });
    const filled = await SearchPages.fill(first, SearchPages.none, 2, fetch);
    expect(filled.restarted).toBe(false);
    expect(paths(SearchPages.shown(first, filled))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("replaces the list with a restarted page and pages on from it, never appending", async () => {
    // The user had two pages and asked for a third; the server could not continue.
    const shown = { head: null, pages: [page(["c", "d"], "c2")] };
    const { fetch, asked } = server({
      c2: page(["b", "z", "a"], "r1", true),
      r1: page(["c", "e"], "r2"),
      r2: page(["f"], null),
    });
    const filled = await SearchPages.fill(first, shown, 3, fetch);
    expect(filled.restarted).toBe(true);
    // A fresh first page, then as many pages after it as the user had asked for.
    expect(paths(SearchPages.shown(first, filled))).toEqual([
      "b",
      "z",
      "a",
      "c",
      "e",
      "f",
    ]);
    expect(asked).toEqual(["c2", "r1", "r2"]);
  });

  it("stops at a second restart instead of looping", async () => {
    const { fetch } = server({
      c1: page(["x"], "r1", true),
      r1: page(["y"], "r2", true),
    });
    const filled = await SearchPages.fill(first, SearchPages.none, 4, fetch);
    expect(paths(SearchPages.shown(first, filled))).toEqual(["y"]);
    expect(filled.restarted).toBe(true);
  });

  it("stops where the results end", async () => {
    const { fetch } = server({ c1: page(["c"], null) });
    const filled = await SearchPages.fill(first, SearchPages.none, 5, fetch);
    expect(paths(SearchPages.shown(first, filled))).toEqual(["a", "b", "c"]);
  });

  it("lists each path once", () => {
    expect(paths([page(["a", "b"], "c"), page(["b", "c"], null)])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps a fresh first page and what followed it when a later fetch fails", async () => {
    const { fetch } = server({
      c1: page(["x", "y"], "r1", true),
      r1: page(["z"], "r2"),
    });
    const filled = await SearchPages.fill(first, SearchPages.none, 4, fetch);
    expect(filled.error).toBeInstanceOf(Error);
    expect(filled.restarted).toBe(true);
    expect(paths(SearchPages.shown(first, filled))).toEqual(["x", "y", "z"]);
  });
});
