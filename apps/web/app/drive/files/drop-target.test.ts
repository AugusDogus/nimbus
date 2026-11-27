import { describe, expect, it } from "bun:test";
import { DropTarget, type DragPayload } from "./drop-target";
import type { FileEntry } from "./types";

const entry = (path: string, type: "dir" | "file" = "dir"): FileEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  type,
  permission: "admin",
  mtime: null,
  size: null,
  fixed: false,
});
const moving = (...paths: string[]): DragPayload => ({
  kind: "entries",
  sources: paths.map((path) => entry(path)),
  skipped: 0,
});
const folder = (path: string, writable = true) => ({ path, writable });

describe("dropping on a folder", () => {
  it("moves items into a writable folder elsewhere, the drive root included", () => {
    expect(DropTarget.verdict(moving("a/b/c"), folder("a"))).toEqual({
      kind: "move",
    });
    expect(DropTarget.verdict(moving("a/b/c", "a/b/d"), folder(""))).toEqual({
      kind: "move",
    });
    expect(DropTarget.hint({ kind: "move" }, folder(""), "")).toBe(
      "Move to “Files”",
    );
  });

  it("names the account's top folder Files, as its breadcrumb does", () => {
    expect(
      DropTarget.hint({ kind: "move" }, folder("users/ann"), "users/ann"),
    ).toBe("Move to “Files”");
    expect(
      DropTarget.alreadyThere(
        [{ path: "users/ann/a.txt" }, { path: "users/ann/Photos/b.txt" }],
        folder("users/ann"),
        "users/ann",
      ),
    ).toBe("1 of 2 items is already in “Files” and stays there");
  });

  it("refuses the dragged folder itself and any folder inside it", () => {
    expect(DropTarget.verdict(moving("a/b"), folder("a/b"))).toEqual({
      kind: "refused",
      reason: "itself",
    });
    expect(DropTarget.verdict(moving("a/b"), folder("a/b/c/d"))).toEqual({
      kind: "refused",
      reason: "inside-itself",
    });
    // A sibling whose name starts with the folder's is not inside it.
    expect(DropTarget.verdict(moving("a/b"), folder("a/bc"))).toEqual({
      kind: "move",
    });
  });

  it("refuses a folder the account can only view, for moves and uploads", () => {
    expect(DropTarget.verdict(moving("a/b"), folder("x", false))).toEqual({
      kind: "refused",
      reason: "read-only",
    });
    expect(DropTarget.verdict({ kind: "files" }, folder("x", false))).toEqual({
      kind: "refused",
      reason: "read-only",
    });
  });

  it("refuses the folder the items are already in", () => {
    expect(DropTarget.verdict(moving("a/b", "a/c"), folder("a"))).toEqual({
      kind: "refused",
      reason: "already-there",
    });
  });

  it("uploads files from the computer into any writable folder", () => {
    expect(DropTarget.verdict({ kind: "files" }, folder("a/b"))).toEqual({
      kind: "upload",
    });
    expect(DropTarget.hint({ kind: "upload" }, folder("a/b"), "")).toBe(
      "Upload to “b”",
    );
  });

  it("takes folder rows as targets, not files", () => {
    expect(DropTarget.ofEntry(entry("a/b"))).toEqual({
      path: "a/b",
      writable: true,
    });
    expect(DropTarget.ofEntry(entry("a/b.txt", "file"))).toBeNull();
    expect(DropTarget.ofEntry({ ...entry("a/b"), permission: "read" })).toEqual(
      { path: "a/b", writable: false },
    );
  });
});

describe("a drag that leaves items behind", () => {
  it("says how many of the selection cannot be moved", () => {
    expect(DropTarget.leftBehind({ dragged: 3, skipped: 2 })).toBe(
      "2 of 5 items cannot be moved from here",
    );
    expect(DropTarget.leftBehind({ dragged: 1, skipped: 1 })).toBe(
      "1 of 2 items cannot be moved from here",
    );
    expect(DropTarget.leftBehind({ dragged: 4, skipped: 0 })).toBeNull();
  });
});

describe("moving or copying items into a folder", () => {
  const sources = [{ path: "projects/alpha" }, { path: "projects/notes.txt" }];

  it("refuses moving items into the folder they are all in, but not copying them there", () => {
    expect(DropTarget.forItems("move", sources, folder("projects"))).toEqual({
      kind: "refused",
      reason: "already-there",
    });
    expect(DropTarget.forItems("copy", sources, folder("projects"))).toEqual({
      kind: "copy",
    });
  });

  it("takes items from several folders into one of them, moving only those not there", () => {
    const mixed = [...sources, { path: "elsewhere/x.txt" }];
    expect(DropTarget.forItems("move", mixed, folder("projects"))).toEqual({
      kind: "move",
    });
    expect(
      DropTarget.notIn(mixed, "projects").map((source) => source.path),
    ).toEqual(["elsewhere/x.txt"]);
  });

  it("refuses the items and what lies inside them, for copies too", () => {
    for (const operation of ["move", "copy"] as const) {
      expect(
        DropTarget.forItems(operation, sources, folder("projects/alpha")),
      ).toEqual({ kind: "refused", reason: "itself" });
      expect(
        DropTarget.forItems(operation, sources, folder("projects/alpha/deep")),
      ).toEqual({ kind: "refused", reason: "inside-itself" });
    }
    expect(
      DropTarget.forItems("move", sources, folder("projects/alpha-2")),
    ).toEqual({ kind: "move" });
  });

  it("keeps a refused folder open when it can lead to one that takes the items", () => {
    expect(
      DropTarget.hint(
        { kind: "refused", reason: "read-only" },
        folder("shared", false),
        "",
      ),
    ).toBe("You can only view “shared”, so nothing can go there");
  });

  it("says how many of the items are already in the folder and stay there", () => {
    const mixed = [...sources, { path: "elsewhere/x.txt" }];
    expect(DropTarget.alreadyThere(mixed, folder("projects"), "")).toBe(
      "2 of 3 items are already in “projects” and stay there",
    );
    expect(
      DropTarget.alreadyThere(
        [{ path: "projects/a.txt" }, { path: "elsewhere/x.txt" }],
        folder("projects"),
        "",
      ),
    ).toBe("1 of 2 items is already in “projects” and stays there");
    expect(DropTarget.alreadyThere(sources, folder("archive"), "")).toBeNull();
    expect(DropTarget.alreadyThere(sources, folder("projects"), "")).toBeNull();
  });
});

describe("the hint while items are dragged", () => {
  it("names what a drop does, and says Esc cancels, over a folder or not", () => {
    const three = moving("a/x", "a/y", "a/z");
    expect(DropTarget.dragText(three, null, "")).toBe(
      "Drop on a folder to move 3 items · Esc to cancel",
    );
    expect(
      DropTarget.dragText(
        three,
        { target: folder("b/Photos"), verdict: { kind: "move" } },
        "",
      ),
    ).toBe("Move 3 items to “Photos” · Esc to cancel");
    expect(
      DropTarget.dragText(
        moving("a/x.txt"),
        { target: folder("b"), verdict: { kind: "copy" } },
        "",
      ),
    ).toBe("Copy “x.txt” to “b” · Esc to cancel");
    expect(
      DropTarget.dragText(
        moving("a/x"),
        {
          target: folder("a"),
          verdict: { kind: "refused", reason: "already-there" },
        },
        "",
      ),
    ).toBe("Already in “a” · Esc to cancel");
  });

  it("says only where files from the computer go, and nothing before they are over a folder", () => {
    expect(
      DropTarget.dragText(
        { kind: "files" },
        { target: folder("b"), verdict: { kind: "upload" } },
        "",
      ),
    ).toBe("Upload to “b”");
    expect(DropTarget.dragText({ kind: "files" }, null, "")).toBe("");
  });
});
