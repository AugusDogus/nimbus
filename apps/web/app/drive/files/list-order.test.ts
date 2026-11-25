import { describe, expect, test } from "bun:test";
import { ListOrder } from "./list-order";
import type { FileEntry } from "./types";

const entry = (name: string, mtime: number, size: number): FileEntry => ({
  name,
  path: `a/${name}`,
  type: "file",
  mtime,
  size,
  permission: "read",
  fixed: false,
});

describe("ListOrder", () => {
  test("each page starts from its own default, and its address names only other orders", () => {
    expect(ListOrder.pick("recent", undefined).value).toBe("recent");
    expect(ListOrder.pick("search", undefined).value).toBe("relevance");
    expect(ListOrder.pick("starred", undefined).value).toBe("name-asc");
    expect(ListOrder.pick("shared", "nonsense").value).toBe("name-asc");
    expect(ListOrder.param("recent", ListOrder.pick("recent", "recent"))).toBe(
      undefined,
    );
    expect(
      ListOrder.param("recent", ListOrder.pick("recent", "size-desc")),
    ).toBe("size-desc");
  });

  test("kept orders keep the server's, others sort as a folder does", () => {
    const entries = [entry("b", 2, 10), entry("a", 1, 30), entry("c", 3, 20)];
    const names = (order: string, page: "recent" | "search") =>
      ListOrder.apply(entries, ListOrder.pick(page, order)).map(
        (each) => each.name,
      );
    expect(names("recent", "recent")).toEqual(["b", "a", "c"]);
    expect(names("relevance", "search")).toEqual(["b", "a", "c"]);
    expect(names("name-asc", "search")).toEqual(["a", "b", "c"]);
    expect(names("size-desc", "recent")).toEqual(["a", "c", "b"]);
    expect(names("modified-desc", "recent")).toEqual(["c", "b", "a"]);
  });

  test("search offers no type order", () => {
    expect(
      ListOrder.forPage.search.some((order) => order.value.startsWith("type")),
    ).toBe(false);
  });
});
