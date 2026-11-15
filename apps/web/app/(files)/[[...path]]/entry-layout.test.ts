import { describe, expect, it } from "bun:test";
import { EntryLayout } from "./entry-layout";

const entries = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ path: `${prefix}${index}` }));

describe("entry layout", () => {
  it("stacks titled sections with fixed list rows", () => {
    const layout = EntryLayout.build([{ title: "Folders", entries: entries("d", 2) }, { title: "Files", entries: entries("f", 3) }], "list", 1);
    expect(layout.rows.map((row) => (row.kind === "header" ? row.title : row.start))).toEqual(["Folders", 0, 1, "Files", 2, 3, 4]);
    expect(layout.rows.map((row) => row.top)).toEqual([0, 28, 80, 152, 180, 232, 284]);
    expect(layout.height).toBe(332);
    expect(layout.entries.map((entry) => entry.path)).toEqual(["d0", "d1", "f0", "f1", "f2"]);
    expect(EntryLayout.rowOf(layout, 3)).toBe(5);
  });

  it("groups grid cards into rows of the current column count and skips empty sections", () => {
    const layout = EntryLayout.build([{ title: "Folders", entries: [] }, { title: "", entries: entries("f", 7) }], "grid", 3);
    expect(layout.rows).toEqual([
      { kind: "entries", start: 0, count: 3, top: 0, height: 168 },
      { kind: "entries", start: 3, count: 3, top: 180, height: 168 },
      { kind: "entries", start: 6, count: 1, top: 360, height: 168 },
    ]);
    expect(EntryLayout.rowOf(layout, 6)).toBe(2);
  });

  it("finds rows intersecting a window with binary search", () => {
    const layout = EntryLayout.build([{ title: "", entries: entries("f", 50_000) }], "list", 1);
    expect(EntryLayout.rangeAt(layout, 0, 100)).toEqual({ start: 0, end: 2 });
    expect(EntryLayout.rangeAt(layout, 52 * 1000 + 10, 52 * 1000 + 60)).toEqual({ start: 1000, end: 1002 });
    expect(EntryLayout.rangeAt(layout, -500, -1)).toEqual({ start: 0, end: 0 });
    expect(EntryLayout.rangeAt(layout, layout.height + 10, layout.height + 50)).toEqual({ start: 50_000, end: 50_000 });
  });

  it("builds a 50,000 entry grid layout quickly", () => {
    const started = performance.now();
    const layout = EntryLayout.build([{ title: "Folders", entries: entries("d", 1000) }, { title: "Files", entries: entries("f", 49_000) }], "grid", 6);
    expect(layout.rows.length).toBe(2 + Math.ceil(1000 / 6) + Math.ceil(49_000 / 6));
    expect(performance.now() - started).toBeLessThan(50);
  });
});
