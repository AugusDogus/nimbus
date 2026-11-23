import { describe, expect, it } from "bun:test";
import { EntryLayout } from "./entry-layout";

const entries = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ path: `${prefix}${index}` }));

describe("entry layout", () => {
  it("stacks titled sections with fixed list rows", () => {
    const layout = EntryLayout.build(
      [
        { title: "Folders", entries: entries("d", 2) },
        { title: "Files", entries: entries("f", 3) },
      ],
      "list",
      EntryLayout.listTrack,
    );
    expect(
      layout.rows.map((row) => (row.kind === "header" ? row.title : row.start)),
    ).toEqual(["Folders", 0, 1, "Files", 2, 3, 4]);
    expect(layout.rows.map((row) => row.top)).toEqual([
      0, 28, 80, 152, 180, 232, 284,
    ]);
    expect(layout.height).toBe(332);
    expect(layout.entries.map((entry) => entry.path)).toEqual([
      "d0",
      "d1",
      "f0",
      "f1",
      "f2",
    ]);
    expect(EntryLayout.rowOf(layout, 3)).toBe(5);
  });

  it("groups grid cards into rows of the current column count and skips empty sections", () => {
    const layout = EntryLayout.build(
      [
        { title: "Folders", entries: [] },
        { title: "", entries: entries("f", 7) },
      ],
      "grid",
      { columns: 3, height: 120 },
    );
    expect(layout.rows).toEqual([
      { kind: "entries", start: 0, count: 3, top: 0, height: 120 },
      { kind: "entries", start: 3, count: 3, top: 132, height: 120 },
      { kind: "entries", start: 6, count: 1, top: 264, height: 120 },
    ]);
    expect(EntryLayout.rowOf(layout, 6)).toBe(2);
  });

  it("finds rows intersecting a window with binary search", () => {
    const layout = EntryLayout.build(
      [{ title: "", entries: entries("f", 50_000) }],
      "list",
      EntryLayout.listTrack,
    );
    expect(EntryLayout.rangeAt(layout, 0, 100)).toEqual({ start: 0, end: 2 });
    expect(EntryLayout.rangeAt(layout, 52 * 1000 + 10, 52 * 1000 + 60)).toEqual(
      { start: 1000, end: 1002 },
    );
    expect(EntryLayout.rangeAt(layout, -500, -1)).toEqual({ start: 0, end: 0 });
    expect(
      EntryLayout.rangeAt(layout, layout.height + 10, layout.height + 50),
    ).toEqual({ start: 50_000, end: 50_000 });
  });

  it("builds a 50,000 entry grid layout quickly", () => {
    const started = performance.now();
    const layout = EntryLayout.build(
      [
        { title: "Folders", entries: entries("d", 1000) },
        { title: "Files", entries: entries("f", 49_000) },
      ],
      "grid",
      { columns: 6, height: 135 },
    );
    expect(layout.rows.length).toBe(
      2 + Math.ceil(1000 / 6) + Math.ceil(49_000 / 6),
    );
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("fits as many landscape cards as the width allows, and drops columns instead of thinning them", () => {
    // A phone, a narrow pane, a half pane at 1680 px and a full listing.
    expect(EntryLayout.gridTrack(358)).toEqual({ columns: 2, height: 130 });
    expect(EntryLayout.gridTrack(440)).toEqual({ columns: 2, height: 161 });
    expect(EntryLayout.gridTrack(680)).toEqual({ columns: 4, height: 121 });
    expect(EntryLayout.gridTrack(1376)).toEqual({ columns: 8, height: 121 });
    for (let width = 100; width <= 2400; width += 7) {
      const { columns, height } = EntryLayout.gridTrack(width);
      const card = (width - (columns - 1) * 12) / columns;
      expect(height).toBeLessThanOrEqual(Math.max(160, card));
      if (width >= 160) expect(card).toBeGreaterThanOrEqual(160);
    }
  });
});
