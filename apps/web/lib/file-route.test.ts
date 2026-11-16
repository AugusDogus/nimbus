import { describe, expect, it } from "bun:test";
import { decodeFilePathSegments } from "./file-route";

describe("decodeFilePathSegments", () => {
  it("handles root and single-segment routes", () => {
    expect(decodeFilePathSegments(undefined)).toEqual([]);
    expect(decodeFilePathSegments([])).toEqual([]);
    expect(decodeFilePathSegments("")).toEqual([]);
    expect(decodeFilePathSegments("Meeting%20notes")).toEqual([
      "Meeting notes",
    ]);
  });

  it("decodes nested names exactly once", () => {
    const names = [
      "Project documents",
      "Budget 100% # café %20",
      "Weekly summary.txt",
    ];
    expect(decodeFilePathSegments(names.map(encodeURIComponent))).toEqual(
      names,
    );
  });
});
