import { describe, expect, it } from "bun:test";
import { FileEntry } from "./types";

const file: FileEntry = {
  name: "notes.txt",
  path: "projects/notes.txt",
  type: "file",
  permission: "write",
  mtime: null,
  size: null,
};
const folder: FileEntry = {
  ...file,
  name: "archive",
  path: "archive",
  type: "dir",
  permission: "admin",
};

describe("file move eligibility", () => {
  it("allows writable files and requires admin access to move folders", () => {
    expect(FileEntry.canMove(file)).toBe(true);
    expect(FileEntry.canMove(folder)).toBe(true);
    expect(FileEntry.canMove({ ...file, permission: "read" })).toBe(false);
    expect(FileEntry.canMove({ ...folder, permission: "write" })).toBe(false);
    expect(FileEntry.canMove({ ...folder, path: "" })).toBe(false);
  });

  it("accepts writable folders and rejects read-only or file destinations", () => {
    expect(FileEntry.canMoveInto(file, folder)).toBe(true);
    expect(
      FileEntry.canMoveInto(file, { ...folder, permission: "write" }),
    ).toBe(true);
    expect(FileEntry.canMoveInto(file, { ...folder, permission: "read" })).toBe(
      false,
    );
    expect(FileEntry.canMoveInto(file, { ...folder, type: "file" })).toBe(
      false,
    );
    expect(FileEntry.canMoveInto({ ...file, permission: "read" }, folder)).toBe(
      false,
    );
  });

  it("rejects moves into the source, its descendants, or its current parent", () => {
    expect(FileEntry.canMoveInto(folder, folder)).toBe(false);
    expect(
      FileEntry.canMoveInto(folder, { ...folder, path: "archive/nested" }),
    ).toBe(false);
    expect(FileEntry.canMoveInto(file, { ...folder, path: "projects" })).toBe(
      false,
    );
    expect(FileEntry.canMoveInto(folder, { ...folder, path: "" })).toBe(false);
    expect(
      FileEntry.canMoveInto(folder, { ...folder, path: "archive-old" }),
    ).toBe(true);
  });
});
