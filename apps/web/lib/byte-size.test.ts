import { expect, test } from "bun:test";
import { ByteSize } from "./byte-size";

test("byte sizes format in binary units and round-trip megabyte fields", () => {
  expect(ByteSize.format(0)).toBe("0 B");
  expect(ByteSize.format(1536)).toBe("1.5 KB");
  expect(ByteSize.format(25 * 1024 * 1024)).toBe("25 MB");
  expect(ByteSize.fromMegabytesInput("")).toBeNull();
  expect(ByteSize.fromMegabytesInput("1.5")).toBe(1572864);
  expect(ByteSize.toMegabytesInput(1572864)).toBe("1.5");
  expect(ByteSize.toMegabytesInput(null)).toBe("");
});
