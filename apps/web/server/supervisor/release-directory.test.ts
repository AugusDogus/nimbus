import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "./protocol";
import { ReleaseDirectory } from "./release-directory";

let releases: string;
beforeEach(async () => {
  releases = await mkdtemp(path.join(os.tmpdir(), "nimbus-releases-"));
});
afterEach(async () => {
  await rm(releases, { recursive: true, force: true });
});

async function release(name: string, metadata: unknown) {
  const web = path.join(releases, name, "apps/web");
  await mkdir(path.join(web, "server"), { recursive: true });
  await writeFile(path.join(web, "server/start.ts"), "");
  if (metadata !== undefined)
    await writeFile(path.join(web, "release.json"), JSON.stringify(metadata));
}

test("a release that speaks this supervisor's protocol may start", async () => {
  await release("next", { supervisorProtocol: PROTOCOL_VERSION });
  expect(ReleaseDirectory.resolve(releases, "next")).toEqual({
    ok: true,
    release: { name: "next", root: path.join(releases, "next") },
  });
});

test("an older release, or one that does not say, never starts beside this supervisor", async () => {
  await release("older", { supervisorProtocol: PROTOCOL_VERSION - 1 });
  await release("silent", undefined);
  for (const name of ["older", "silent"]) {
    const resolved = ReleaseDirectory.resolve(releases, name);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain("protocol");
  }
});

test("a missing or malformed release is refused", async () => {
  for (const name of ["absent", "../escape", ".hidden"]) {
    const resolved = ReleaseDirectory.resolve(releases, name);
    expect(resolved.ok).toBe(false);
  }
});

test("this repository's own release says the protocol the code speaks", async () => {
  const own: unknown = await Bun.file(
    path.join(import.meta.dir, "../../release.json"),
  ).json();
  expect(own).toEqual({ supervisorProtocol: PROTOCOL_VERSION });
});

test("the protocol changed with the recovery messages", () => {
  // Version 1 had `alone` and `fence-done`; version 2 has `recover`, `fence-release` and
  // `recovered`. A worker of one never runs under a supervisor of the other.
  expect(PROTOCOL_VERSION).toBe(3);
});
