import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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

test("a starting server waits for the server processes of an earlier start to exit", async () => {
  // One left running by a supervisor that died, still draining.
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { InstallationLock } = await import(${JSON.stringify(`${import.meta.dir}/installation-lock.ts`)});
       const held = InstallationLock.lease(${JSON.stringify(configRoot)}, "earlier-run-1");
       console.log(held.ok ? "held" : held.error.message);
       await Bun.sleep(60_000);`,
    ],
    { stdout: "pipe" },
  );
  const reader = holder.stdout.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value).trim()).toBe("held");
  const logged: string[] = [];
  let done = false;
  const waiting = InstallationLock.awaitLeases(configRoot, {
    pollMs: 10,
    reportMs: 20,
    log: (line) => logged.push(line),
  }).then((outcome) => {
    done = true;
    return outcome;
  });
  await Bun.sleep(100);
  expect(done).toBe(false);
  expect(logged.join("\n")).toContain(String(holder.pid));
  holder.kill("SIGKILL");
  await holder.exited;
  expect(await waiting).toEqual({ ok: true });
  // What it left behind is cleared.
  expect(await readdir(path.join(configRoot, "leases"))).toEqual([]);
});

test("a lease is released with its holder, and taken by no one else meanwhile", () => {
  const lease = InstallationLock.lease(configRoot, "run-2");
  if (!lease.ok) throw new Error(lease.error.message);
  expect(InstallationLock.lease(configRoot, "run-2").ok).toBe(false);
  lease.value.release();
  const again = InstallationLock.lease(configRoot, "run-2");
  expect(again.ok).toBe(true);
  if (again.ok) again.value.release();
});

test("held in a folder its owner may not write, as the supervisor's lock is in a shared config root", async () => {
  const folder = path.join(configRoot, "shared");
  await mkdir(folder);
  await Bun.write(path.join(folder, "server.lock"), "");
  await chmod(folder, 0o555);
  try {
    const held = InstallationLock.acquire(folder);
    expect(held.ok).toBe(true);
    if (held.ok) {
      expect(InstallationLock.acquire(folder).ok).toBe(false);
      held.value.release();
    }
  } finally {
    await chmod(folder, 0o755);
  }
});
