import { describe, expect, test } from "bun:test";
import { SplitRoom } from "./split-room";

describe("SplitRoom", () => {
  test("hides side-by-side-only parts exactly where two panes do not fit", () => {
    expect<string>(SplitRoom.roomOnly).toBe(
      `@max-[${SplitRoom.minSideBySide - 1}px]/room:hidden`,
    );
  });

  test("splits the window's controls for opening a split at the narrowest window for two panes", () => {
    expect<string>(SplitRoom.swipeOnly).toBe(
      `min-[${SplitRoom.minViewport}px]:hidden`,
    );
    expect<string>(SplitRoom.sideBySideOnly).toBe(
      `max-[${SplitRoom.minViewport - 1}px]:hidden`,
    );
  });

  test("fits two of the narrowest panes and the divider, and nothing narrower", () => {
    const both = 2 * SplitRoom.minPaneWidth + SplitRoom.dividerWidth;
    expect(SplitRoom.fits(both)).toBe(true);
    expect(SplitRoom.fits(both - 1)).toBe(false);
  });

  test("a window gets the mode its folded content area does", () => {
    for (const width of [390, 412, 759, 760, 768, 844, 1024, 1280]) {
      const content = width < 768 ? width - 32 : width - 16;
      expect(SplitRoom.modeForWindow(width)).toBe(SplitRoom.mode(content, 0));
    }
  });
});
