import { describe, expect, it } from "bun:test";
import { SplitLayout } from "../split-layout";
import { SplitAddress } from "./split-address";

describe("writing a split view into the address", () => {
  it("writes the params back, spelling the drive root as a slash", () => {
    const layout = SplitLayout.parse({
      right: "Archive",
      active: "right",
      ratio: "62",
      collapsed: "left",
    });
    if (!layout) throw new Error("Expected a split layout.");
    expect(SplitLayout.parse(SplitAddress.search(layout))).toEqual(layout);
    expect(
      SplitAddress.search({
        right: "",
        active: "left",
        ratio: 50,
        collapsed: null,
      }),
    ).toEqual({ right: "/", active: "left", ratio: "50" });
    expect(
      SplitAddress.href("Projects/Client Alpha", {
        right: "Archive/2026",
        active: "left",
        ratio: 50,
        collapsed: null,
      }),
    ).toBe(
      "/browse/Projects/Client%20Alpha?right=Archive%2F2026&active=left&ratio=50",
    );
    expect(
      SplitAddress.href("", {
        right: "",
        active: "right",
        ratio: 40,
        collapsed: null,
      }),
    ).toBe("/?right=%2F&active=right&ratio=40");
  });

  it("opens a folder in the active pane and leaves the other as it is", () => {
    const layout = {
      right: "Archive",
      active: "right",
      ratio: 50,
      collapsed: null,
    } as const;
    expect(
      SplitAddress.openInActive({ left: "Projects", layout }, "Guides"),
    ).toBe("/browse/Projects?right=Guides&active=right&ratio=50");
    expect(
      SplitAddress.openInActive(
        { left: "Projects", layout: { ...layout, active: "left" } },
        "Guides",
      ),
    ).toBe("/browse/Guides?right=Archive&active=left&ratio=50");
  });

});
