import { expect, test } from "bun:test";
import { MAX_MANIFEST_BYTES, ReleaseManifest } from "./release-manifest";
import { testManifest } from "./updates-testing";

test("a manifest round-trips through the bytes CI signs", () => {
  const manifest = testManifest(42);
  const parsed = ReleaseManifest.parse(ReleaseManifest.encode(manifest));
  expect(parsed).toEqual({ ok: true, value: manifest });
  expect(ReleaseManifest.releaseName(manifest)).toBe(
    `edge-42-${manifest.build.commit.slice(0, 12)}`,
  );
});

test("a manifest that names a bundle outside its folder, or is not one, is refused", () => {
  const traversal = { ...testManifest(1) };
  traversal.bundle = { ...traversal.bundle, file: "../escape.tar.gz" };
  expect(ReleaseManifest.parse(ReleaseManifest.encode(traversal)).ok).toBe(
    false,
  );
  expect(ReleaseManifest.parse(new TextEncoder().encode("{}")).ok).toBe(false);
  expect(ReleaseManifest.parse(new Uint8Array([0xff, 0xfe])).ok).toBe(false);
});

test("an oversized manifest is refused before it is parsed", () => {
  const parsed = ReleaseManifest.parse(new Uint8Array(MAX_MANIFEST_BYTES + 1));
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.error.message).toContain("more than");
});
