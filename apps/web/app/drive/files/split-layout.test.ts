import { describe, expect, it } from "bun:test";
import { SplitLayout } from "./split-layout";
import { validateSplitSearch } from "./split-search";

describe("split view in the address", () => {
  it("shows one folder without a right-hand folder", () => {
    expect(SplitLayout.parse({})).toBeNull();
    expect(SplitLayout.parse({ active: "right", ratio: "40" })).toBeNull();
  });

  it("reads the right folder, the active pane, the ratio and a folded pane", () => {
    expect(
      SplitLayout.parse({
        right: "Archive/2026",
        active: "right",
        ratio: "35",
      }),
    ).toEqual({
      right: "Archive/2026",
      active: "right",
      ratio: 35,
      collapsed: null,
    });
    expect(SplitLayout.parse({ right: "/" })).toEqual({
      right: "",
      active: "left",
      ratio: 50,
      collapsed: null,
    });
  });

  it("falls back to defaults for values it cannot use", () => {
    expect(
      SplitLayout.parse({ right: "//Archive/", active: "up", ratio: "wide" }),
    ).toEqual({ right: "Archive", active: "left", ratio: 50, collapsed: null });
    expect(SplitLayout.parse({ right: "Archive", ratio: "" })?.ratio).toBe(50);
    expect(SplitLayout.parse({ right: "Archive", ratio: "3" })?.ratio).toBe(10);
    expect(SplitLayout.parse({ right: "Archive", ratio: "97.6" })?.ratio).toBe(
      90,
    );
    expect(SplitLayout.parse({ right: "Archive", ratio: 40 })?.ratio).toBe(50);
  });

  it("refuses a right folder that climbs out of the drive", () => {
    expect(SplitLayout.parse({ right: "../secrets" })).toBeNull();
    expect(SplitLayout.parse({ right: "Archive/./x" })).toBeNull();
  });

  it("makes the open pane active when the active one is folded away", () => {
    expect(
      SplitLayout.parse({
        right: "Archive",
        active: "right",
        collapsed: "right",
      }),
    ).toMatchObject({ active: "left", collapsed: "right" });
  });

  it("keeps only the split params of a route's search", () => {
    expect(
      validateSplitSearch({ right: "Archive", q: "notes", ratio: 50 }),
    ).toEqual({
      right: "Archive",
      active: undefined,
      ratio: undefined,
      collapsed: undefined,
    });
  });
});

describe("which folder a command acts on", () => {
  const layout = (active: "left" | "right") => ({
    right: "Archive",
    active,
    ratio: 50,
    collapsed: null,
  });

  it("is the one folder shown without a split", () => {
    expect(SplitLayout.activePath("Projects", null)).toBe("Projects");
  });

  it("is the active pane's folder in a split", () => {
    expect(SplitLayout.activePath("Projects", layout("left"))).toBe("Projects");
    expect(SplitLayout.activePath("Projects", layout("right"))).toBe("Archive");
    expect(SplitLayout.activePath("", layout("left"))).toBe("");
  });

  it("names each pane's folder", () => {
    expect(SplitLayout.pathOf("Projects", layout("left"), "right")).toBe(
      "Archive",
    );
    expect(SplitLayout.pathOf("Projects", layout("right"), "left")).toBe(
      "Projects",
    );
  });
});
