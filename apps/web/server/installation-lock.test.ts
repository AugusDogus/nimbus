import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InstallationLock } from "./installation-lock";

let configRoot: string;
beforeEach(async () => {
  configRoot = await mkdtemp(path.join(os.tmpdir(), "nimbus-installation-"));
});
afterEach(async () => {
  await rm(configRoot, { recursive: true, force: true });
});

test("one holder at a time, and free again once released", () => {
  const first = InstallationLock.acquire(configRoot);
  if (!first.ok) throw new Error(first.error.message);
  const second = InstallationLock.acquire(configRoot);
  expect(second.ok).toBe(false);
  if (!second.ok) {
    expect(second.error.kind).toBe("held");
    expect(second.error.message).toContain(configRoot);
  }
  first.value.release();
  const third = InstallationLock.acquire(configRoot);
  expect(third.ok).toBe(true);
  if (third.ok) third.value.release();
});

test("held by another process until that process exits, however it exits", async () => {
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { InstallationLock } = await import(${JSON.stringify(`${import.meta.dir}/installation-lock.ts`)});
       const held = InstallationLock.acquire(${JSON.stringify(configRoot)});
       console.log(held.ok ? "held" : held.error.message);
       await Bun.sleep(60_000);`,
    ],
    { stdout: "pipe" },
  );
  const reader = holder.stdout.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value).trim()).toBe("held");
  expect(InstallationLock.acquire(configRoot).ok).toBe(false);
  holder.kill("SIGKILL");
  await holder.exited;
  const after = InstallationLock.acquire(configRoot);
  expect(after.ok).toBe(true);
  if (after.ok) after.value.release();
});

test("stays held when nothing refers to it any more", async () => {
  // A server holds the lock for its life without touching it again.
  expect(InstallationLock.acquire(configRoot).ok).toBe(true);
  Bun.gc(true);
  await Bun.sleep(50);
  Bun.gc(true);
  const child = Bun.spawnSync([
    process.execPath,
    "-e",
    `const { InstallationLock } = await import(${JSON.stringify(`${import.meta.dir}/installation-lock.ts`)});
     console.log(InstallationLock.acquire(${JSON.stringify(configRoot)}).ok ? "acquired" : "refused");`,
  ]);
  expect(child.stdout.toString().trim()).toBe("refused");
});
