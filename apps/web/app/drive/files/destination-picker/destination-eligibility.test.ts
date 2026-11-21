import { describe, expect, it } from "bun:test";
import { DestinationEligibility } from "./destination-eligibility";

const of = DestinationEligibility.of;
const folder = (
  path: string,
  permission: "read" | "write" | "admin" = "write",
) => ({
  path,
  permission,
});

describe("destination eligibility", () => {
  const sources = [{ path: "projects/alpha" }, { path: "projects/notes.txt" }];

  it("accepts a writable folder elsewhere", () => {
    expect(of("move", sources, folder("archive"))).toEqual({
      kind: "eligible",
    });
    expect(of("copy", sources, folder("archive", "admin"))).toEqual({
      kind: "eligible",
    });
  });

  it("refuses the item itself and anything inside it, which lead nowhere", () => {
    for (const operation of ["move", "copy"] as const) {
      expect(of(operation, sources, folder("projects/alpha"))).toEqual({
        kind: "blocked",
        reason: "self",
        navigable: false,
      });
      expect(of(operation, sources, folder("projects/alpha/deep/er"))).toEqual({
        kind: "blocked",
        reason: "inside",
        navigable: false,
      });
    }
    // A sibling whose name starts the same is not inside it.
    expect(of("move", sources, folder("projects/alpha-2"))).toEqual({
      kind: "eligible",
    });
  });

  it("refuses moving items into the folder they are all in, but not copying them there", () => {
    expect(of("move", sources, folder("projects"))).toEqual({
      kind: "blocked",
      reason: "already-here",
      navigable: true,
    });
    expect(of("copy", sources, folder("projects"))).toEqual({
      kind: "eligible",
    });
    // Items from several folders can go to one of them; the others move.
    expect(
      of("move", [...sources, { path: "elsewhere/x.txt" }], folder("projects")),
    ).toEqual({ kind: "eligible" });
    expect(of("move", [{ path: "top.txt" }], folder(""))).toMatchObject({
      reason: "already-here",
    });
  });

  it("keeps a read-only folder open to reach writable folders inside it", () => {
    expect(of("move", sources, folder("shared", "read"))).toEqual({
      kind: "blocked",
      reason: "read-only",
      navigable: true,
    });
  });

  it("explains each reason for the footer", () => {
    expect(DestinationEligibility.explain("read-only", 3)).toBe(
      "You can only view this folder, so these items cannot go here. Open a folder inside it or choose another.",
    );
    expect(DestinationEligibility.explain("already-here", 1)).toBe(
      "This item is already here. Choose another folder.",
    );
  });
});
