import { describe, expect, it } from "bun:test";
import { FileKind } from "./file-kind";
import { hasThumbnail, thumbnailExtensions } from "./thumbnail-kind";

describe("FileKind", () => {
  it("classifies by extension case-insensitively", () => {
    expect(FileKind.of("Photo.JPG")).toEqual({ type: "image", mime: "image/jpeg" });
    expect(FileKind.of("notes.md").type).toBe("markdown");
    expect(FileKind.of("main.tsx")).toEqual({ type: "code", language: "typescript" });
    expect(FileKind.of("Dockerfile")).toEqual({ type: "code", language: "shell" });
    expect(FileKind.of("archive.tar.gz").type).toBe("other");
  });

  it("treats dotfiles without an extension as unknown unless named", () => {
    expect(FileKind.of(".bashrc").type).toBe("other");
    expect(FileKind.of(".gitignore").type).toBe("text");
  });

  it("serves every text-like kind as plain text, never as markup", () => {
    for (const name of ["page.html", "image.svg.txt", "data.json", "readme.md", "table.csv", "feed.xml"]) {
      const kind = FileKind.of(name);
      expect(FileKind.isText(kind)).toBe(true);
      expect(FileKind.previewContentType(kind)).toBe("text/plain; charset=utf-8");
    }
    expect(FileKind.previewContentType(FileKind.of("tool.exe"))).toBe("application/octet-stream");
  });

  it("offers thumbnails only for raster images, PDFs and videos", () => {
    for (const extension of thumbnailExtensions())
      expect(["image", "video", "pdf"]).toContain(FileKind.of(`a.${extension}`).type);
    expect(hasThumbnail("Photo.JPG")).toBe(true);
    expect(hasThumbnail("a.pdf")).toBe(true);
    expect(hasThumbnail("a.svg")).toBe(false);
    expect(hasThumbnail("a.mp3")).toBe(false);
    expect(hasThumbnail(".png")).toBe(false);
  });
});
