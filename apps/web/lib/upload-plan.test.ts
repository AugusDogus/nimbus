import { describe, expect, it } from "bun:test";
import { UploadPlan, type EntryKind } from "./upload-plan";
import { collectPicked, type CollectedUpload } from "./upload-sources";

const file = (name: string, relative = "") => {
  const value = new File(["x"], name);
  Object.defineProperty(value, "webkitRelativePath", { value: relative });
  return value;
};
const upload: CollectedUpload = {
  sources: [
    { file: file("notes.txt"), folder: "" },
    { file: file("a.jpg"), folder: "photos" },
    { file: file("b.jpg"), folder: "photos/day 1" },
    { file: file("new.txt"), folder: "" },
  ],
  emptyFolders: ["photos/empty", "fresh"],
  skipped: [],
};
const existing = new Map<string, EntryKind>([["notes.txt", "file"], ["photos", "dir"], ["photos (1)", "dir"]]);
const target = { path: "docs", userId: "user-1" };
const summary = (result: ReturnType<typeof UploadPlan.plan>) => ({
  requests: result.requests.map((request) => `${request.folder}|${request.filename}|${request.conflict}`),
  folders: result.folders,
});

describe("upload planning", () => {
  it("reports top-level clashes with their kinds and file counts", () => {
    expect(UploadPlan.clashes(upload, existing)).toEqual([
      { name: "notes.txt", kind: "file", existing: "file", files: 1 },
      { name: "photos", kind: "dir", existing: "dir", files: 2 },
    ]);
    expect(UploadPlan.canReplace({ kind: "file", existing: "dir" })).toBe(false);
  });

  it("replaces files and merges folders, overwriting same-named files inside", () => {
    const choices = new Map([["notes.txt", "replace"], ["photos", "replace"]] as const);
    expect(summary(UploadPlan.plan(upload, existing, choices, target))).toEqual({
      requests: ["|notes.txt|replace", "photos|a.jpg|replace", "photos/day 1|b.jpg|replace", "|new.txt|keep-both"],
      folders: ["photos/empty", "fresh"],
    });
  });

  it("keeps both by renaming a clashing folder to the next free number", () => {
    const choices = new Map([["notes.txt", "keep-both"], ["photos", "keep-both"]] as const);
    expect(summary(UploadPlan.plan(upload, existing, choices, target))).toEqual({
      requests: ["|notes.txt|keep-both", "photos (2)|a.jpg|keep-both", "photos (2)/day 1|b.jpg|keep-both", "|new.txt|keep-both"],
      folders: ["photos (2)/empty", "fresh"],
    });
  });

  it("skips clashing items and their empty folders", () => {
    const choices = new Map([["notes.txt", "skip"], ["photos", "skip"]] as const);
    expect(summary(UploadPlan.plan(upload, existing, choices, target))).toEqual({ requests: ["|new.txt|keep-both"], folders: ["fresh"] });
  });

  it("never replaces across kinds", () => {
    const choices = new Map([["photos", "replace"]] as const);
    const fileInTheWay = new Map<string, EntryKind>([["photos", "file"]]);
    expect(summary(UploadPlan.plan(upload, fileInTheWay, choices, target)).requests).toContain("photos (1)|a.jpg|keep-both");
  });

  it("reads folder picker paths, dropping Finder metadata", () => {
    const picked = collectPicked([file("a.jpg", "trip/a.jpg"), file("b.jpg", "trip/day 1/b.jpg"), file(".DS_Store", "trip/.DS_Store")]);
    expect(picked.sources.map((source) => `${source.folder}/${source.file.name}`)).toEqual(["trip/a.jpg", "trip/day 1/b.jpg"]);
  });
});
