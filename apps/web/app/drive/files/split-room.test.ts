import { describe, expect, test } from "bun:test";
import { SplitRoom } from "./split-room";

describe("SplitRoom", () => {
  test("hides side-by-side-only parts exactly where two panes do not fit", () => {
    expect<string>(SplitRoom.toggleOnly).toBe(
      `max-[${SplitRoom.minViewport - 1}px]:hidden`,
    );
    expect<string>(SplitRoom.roomOnly).toBe(
      `@max-[${SplitRoom.minSideBySide - 1}px]/room:hidden`,
    );
    expect<string>(SplitRoom.headerEnd).toContain(
      `min-[${SplitRoom.minViewport}px]:`,
    );
  });

  test("fits two of the narrowest panes and the divider, and nothing narrower", () => {
    const both = 2 * SplitRoom.minPaneWidth + SplitRoom.dividerWidth;
    expect(SplitRoom.fits(both)).toBe(true);
    expect(SplitRoom.fits(both - 1)).toBe(false);
  });
});
