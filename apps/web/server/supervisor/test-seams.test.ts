import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TestSeams } from "./test-seams";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-seams-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const env = {
  NIMBUS_TEST_RELEASES_DIR: "/var/tmp/releases",
  NIMBUS_TEST_RELEASE_KEYS_FILE: "/var/tmp/keys.json",
  NIMBUS_TEST_STORE_DIR: "/var/tmp/store",
  NIMBUS_TEST_UPDATES_WITH_ONE_USER: "1",
};

test("a source checkout lets tests inject releases and keys", async () => {
  await mkdir(path.join(root, ".git"));
  expect(TestSeams.fromEnvironment(env, root)).toEqual({
    releasesDir: "/var/tmp/releases",
    keysFile: "/var/tmp/keys.json",
    storeDir: "/var/tmp/store",
    oneUserUpdates: true,
    refused: null,
  });
  expect(TestSeams.fromEnvironment({}, root)).toEqual({
    releasesDir: null,
    keysFile: null,
    storeDir: null,
    oneUserUpdates: false,
    refused: null,
  });
});

test("an image or an installed release refuses them, and says so", () => {
  const seams = TestSeams.fromEnvironment(env, root);
  expect(seams.releasesDir).toBeNull();
  expect(seams.keysFile).toBeNull();
  expect(seams.storeDir).toBeNull();
  expect(seams.oneUserUpdates).toBe(false);
  expect(seams.refused).toContain("NIMBUS_TEST_STORE_DIR");
  expect(seams.refused).toContain("NIMBUS_TEST_RELEASES_DIR");
  expect(seams.refused).toContain("NIMBUS_TEST_RELEASE_KEYS_FILE");
  // The variables an earlier design read are gone: nothing reads them any more.
  expect(
    TestSeams.fromEnvironment(
      {
        NIMBUS_RELEASES_DIR: "/var/tmp/releases",
        NIMBUS_RELEASE_KEYS_FILE: "/var/tmp/keys.json",
      },
      root,
    ),
  ).toEqual({
    releasesDir: null,
    keysFile: null,
    storeDir: null,
    oneUserUpdates: false,
    refused: null,
  });
});
