import { expect, it } from "bun:test";
import { NAME_BYTES, numberedName } from "./numbered-name";

const bytes = (name: string) => Buffer.byteLength(name);

it("numbers a name before a file's extension", () => {
  expect(numberedName("report.pdf", 0, true)).toBe("report.pdf");
  expect(numberedName("report.pdf", 2, true)).toBe("report (2).pdf");
  expect(numberedName("archive.v2", 1, false)).toBe("archive.v2 (1)");
});

it("shortens the name to fit the filesystem's 255-byte limit, keeping the extension", () => {
  const long = `${"a".repeat(251)}.txt`;
  expect(bytes(long)).toBe(NAME_BYTES);
  const numbered = numberedName(long, 12, true);
  expect(bytes(numbered)).toBeLessThanOrEqual(NAME_BYTES);
  expect(numbered.endsWith(" (12).txt")).toBe(true);
  expect(numberedName("b".repeat(255), 3, false)).toBe(
    `${"b".repeat(251)} (3)`,
  );
});

it("counts bytes, and never splits a character", () => {
  // 85 three-byte characters: 255 bytes.
  const wide = "日".repeat(85);
  const numbered = numberedName(wide, 1, false);
  expect(bytes(numbered)).toBeLessThanOrEqual(NAME_BYTES);
  expect(numbered).toBe(`${"日".repeat(83)} (1)`);
  // Four-byte characters are kept whole too.
  const emoji = "😀".repeat(63);
  expect(numberedName(emoji, 1, false)).toBe(`${"😀".repeat(62)} (1)`);
});

it("shortens an extension too long to keep, rather than exceed the limit", () => {
  const name = `a.${"x".repeat(253)}`;
  const numbered = numberedName(name, 1, true);
  expect(bytes(numbered)).toBeLessThanOrEqual(NAME_BYTES);
  expect(numbered.endsWith(" (1)")).toBe(true);
});
