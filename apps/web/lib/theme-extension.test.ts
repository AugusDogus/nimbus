import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { ThemeExtension } from "./theme-extension";

function archive(path: string, files: Record<string, string>) {
  return zipSync(
    Object.fromEntries(
      Object.entries({
        "extension/package.json": JSON.stringify({
          contributes: {
            themes: [{ label: "Night", uiTheme: "vs-dark", path }],
          },
        }),
        ...files,
      }).map(([name, text]) => [name, strToU8(text)]),
    ),
  );
}

/**
 * A stored archive whose central directory lists `copies` entries, all pointing at the one
 * payload and each claiming an uncompressed size of `claimed` bytes.
 */
function forged(payloadBytes: number, copies: number, claimed: number) {
  const zip = zipSync({
    "extension/a00.json": [new Uint8Array(payloadBytes).fill(32), { level: 0 }],
  });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const directoryOffset = view.getUint32(end + 16, true);
  const record = zip.slice(directoryOffset, end);
  const out = new Uint8Array(directoryOffset + record.byteLength * copies + 22);
  out.set(zip.subarray(0, directoryOffset));
  for (let index = 0; index < copies; index++) {
    const copy = record.slice();
    const name = `extension/a${String(index).padStart(2, "0")}.json`;
    copy.set(strToU8(name), 46);
    new DataView(copy.buffer).setUint32(24, claimed, true);
    out.set(copy, directoryOffset + record.byteLength * index);
  }
  const tail = zip.slice(end);
  const tailView = new DataView(tail.buffer);
  tailView.setUint16(8, copies, true);
  tailView.setUint16(10, copies, true);
  tailView.setUint32(12, record.byteLength * copies, true);
  out.set(tail, directoryOffset + record.byteLength * copies);
  return out;
}

describe("theme extensions", () => {
  test("limits what an archive extracts by the bytes it copies, not the sizes it claims", () => {
    // 20 entries sharing one 900 KB payload while claiming 1 byte each would copy 18 MB. A
    // stored entry whose two sizes disagree is corrupt.
    const understated = ThemeExtension.read(forged(900 * 1024, 20, 1));
    expect(understated.ok).toBe(false);
    if (!understated.ok) expect(understated.error).toContain("damaged");
    // Honest sizes still count once per entry, however many share the payload.
    const shared = ThemeExtension.read(forged(900 * 1024, 20, 900 * 1024));
    expect(shared.ok).toBe(false);
    if (!shared.ok) expect(shared.error).toContain("size limit");
    // The forging itself keeps a consistent archive readable.
    const consistent = ThemeExtension.read(forged(1000, 1, 1000));
    expect(consistent.ok).toBe(false);
    if (!consistent.ok) expect(consistent.error).toContain("package.json");
  });

  test("loads contributed themes with relative includes and local overrides", () => {
    const result = ThemeExtension.read(
      archive("./themes/night.json", {
        "extension/base.json":
          '{"colors":{"editor.background":"#123456","sideBar.background":"#234567"}}',
        "extension/themes/night.json":
          '{"include":"../base.json","colors":{"editor.background":"#111111"}}',
        "extension/run.js": 'throw new Error("Extension code must never run");',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.name).toBe("Night");
    expect(result.value[0]?.colors.background).toBe("#111111");
    expect(result.value[0]?.colors.sidebar).toBe("#234567");
  });

  test.each([
    "../../outside.json",
    "/etc/passwd",
    "https://example.com/theme.json",
    "..\\outside.json",
  ])("rejects an include outside the package: %s", (include) => {
    expect(
      ThemeExtension.read(
        archive("themes/night.json", {
          "extension/themes/night.json": JSON.stringify({ include }),
        }),
      ).ok,
    ).toBe(false);
  });

  test("rejects cycles, missing theme files, malformed archives, and oversized JSON", () => {
    expect(
      ThemeExtension.read(
        archive("theme.json", {
          "extension/theme.json": '{"include":"theme.json"}',
        }),
      ).ok,
    ).toBe(false);
    expect(ThemeExtension.read(archive("missing.json", {})).ok).toBe(false);
    expect(ThemeExtension.read(new Uint8Array([1, 2, 3])).ok).toBe(false);
    expect(
      ThemeExtension.read(
        archive("theme.json", {
          "extension/theme.json": " ".repeat(1024 * 1024 + 1),
        }),
      ).ok,
    ).toBe(false);
  });
});
