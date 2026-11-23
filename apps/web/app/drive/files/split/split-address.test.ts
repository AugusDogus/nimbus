import { describe, expect, it } from "bun:test";
import { SplitLayout } from "../split-layout";
import { SplitAddress } from "./split-address";

const fail = (): never => {
  throw new Error("Expected a split layout.");
};

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

  it("reads a split view from a folder page, or from search results that carry one", () => {
    const params = { right: "Archive", active: "right", ratio: "40" };
    const layout = SplitLayout.parse(params) ?? fail();
    expect(
      SplitAddress.carried("/browse/Projects", "Projects", params),
    ).toEqual({ left: "Projects", layout });
    expect(SplitAddress.carried("/search", "", { ...params, q: "notes" })).toBe(
      null,
    );
    expect(
      SplitAddress.carried("/search", "", {
        q: "notes",
        ...SplitAddress.carry({ left: "", layout }),
      }),
    ).toEqual({ left: "", layout });
    expect(SplitAddress.carried("/recent", "", params)).toBe(null);
  });
});
