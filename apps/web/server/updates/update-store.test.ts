import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { UpdateStore } from "./update-store";

let scratch: string;
const self = process.getuid?.() ?? 0;
beforeEach(async () => {
  // Under /var/tmp, sticky and root's, as a store's ancestors may be.
  scratch = await mkdtemp("/var/tmp/nimbus-store-");
  await chmod(scratch, 0o755);
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function laidOut(root: string) {
  await mkdir(path.join(root, "releases"), { recursive: true, mode: 0o755 });
  await mkdir(path.join(root, "staging"), { mode: 0o750 });
  await chmod(root, 0o755);
  await chmod(path.join(root, "staging"), 0o750);
  return UpdateStore.at(root);
}

test("a store laid out as the image lays it out is accepted", async () => {
  const store = await laidOut(path.join(scratch, "store"));
  expect(await UpdateStore.check(store, { owner: self, update: self })).toEqual(
    { ok: true },
  );
});

test("a store others could change, or reach through a link, is refused and left as it is", async () => {
  const store = await laidOut(path.join(scratch, "store"));
  const check = () => UpdateStore.check(store, { owner: self, update: self });
  await chmod(store.releases, 0o777);
  expect((await check()).ok).toBe(false);
  await chmod(store.releases, 0o755);
  await chmod(store.staging, 0o755);
  const open = await check();
  expect(open.ok || open.message).toContain("staging");
  await chmod(store.staging, 0o750);
  // Another user owns the staging folder: as when the servers' user made it.
  const other = await UpdateStore.check(store, {
    owner: self,
    update: self + 1,
  });
  expect(other.ok || other.message).toContain(`not ${self + 1}`);
  await chmod(scratch, 0o777);
  const above = await check();
  expect(above.ok || above.message).toContain("others may change");
  await chmod(scratch, 0o755);
  await symlink(store.root, path.join(scratch, "linked"));
  expect(
    (
      await UpdateStore.check(UpdateStore.at(path.join(scratch, "linked")), {
        owner: self,
        update: self,
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await UpdateStore.check(UpdateStore.at(path.join(scratch, "missing")), {
        owner: self,
        update: self,
      })
    ).ok,
  ).toBe(false);
});
