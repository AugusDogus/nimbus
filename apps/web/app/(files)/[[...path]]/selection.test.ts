import { describe, expect, it } from "bun:test";
import { Selection } from "./selection";

const order = Selection.order(["a", "b", "c", "d", "e"]);
const paths = (selection: Selection) => [...selection.paths].sort();

describe("selection", () => {
  it("selects one item on click and toggles items with a modifier", () => {
    let selection = Selection.only("b");
    expect(paths(selection)).toEqual(["b"]);
    selection = Selection.toggle(selection, "d");
    expect(paths(selection)).toEqual(["b", "d"]);
    selection = Selection.toggle(selection, "b");
    expect(paths(selection)).toEqual(["d"]);
    expect(selection.anchor).toBe("b");
  });

  it("selects a range from the anchor in either direction, replacing or extending", () => {
    let selection = Selection.only("b");
    selection = Selection.range(selection, order, "d", false);
    expect(paths(selection)).toEqual(["b", "c", "d"]);
    expect(selection.anchor).toBe("b");
    selection = Selection.range(selection, order, "a", false);
    expect(paths(selection)).toEqual(["a", "b"]);
    selection = Selection.toggle(Selection.only("e"), "a");
    selection = Selection.range(selection, order, "c", true);
    expect(paths(selection)).toEqual(["a", "b", "c", "e"]);
  });

  it("treats a range without an anchor as a single selection", () => {
    expect(paths(Selection.range(Selection.empty, order, "c", false))).toEqual([
      "c",
    ]);
  });

  it("selects all and drops items that disappear from the folder", () => {
    const selection = Selection.all(order);
    expect(selection.paths.size).toBe(5);
    const next = Selection.retain(selection, Selection.order(["a", "c", "z"]));
    expect(paths(next)).toEqual(["a", "c"]);
    expect(Selection.retain(next, Selection.order(["a", "c"]))).toBe(next);
    expect(Selection.retain(Selection.only("b"), order).anchor).toBe("b");
    expect(
      Selection.retain(Selection.only("b"), Selection.order(["a"])).anchor,
    ).toBeNull();
  });

  it("handles 50,000 entries quickly", () => {
    const large = Selection.order(
      Array.from({ length: 50_000 }, (_, index) => `item ${index}`),
    );
    const started = performance.now();
    const selection = Selection.range(
      Selection.only("item 10"),
      large,
      "item 49990",
      false,
    );
    Selection.retain(selection, large);
    expect(selection.paths.size).toBe(49_981);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
