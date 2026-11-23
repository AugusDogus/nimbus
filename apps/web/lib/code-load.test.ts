import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { CodeLoad } from "./code-load";
import { LeaveGuard } from "./leave-guard";

// The page these tests run in: built from index-old.js, which a deployment replaced.
const entry = "/assets/index-old.js";
const stored = new Map<string, string>();
const reload = mock(() => undefined);
const entryGone = mock(async () => new Response(null, { status: 404 }));
const page = {
  document: {
    querySelector: () => ({ src: `https://nimbus.test${entry}` }),
  },
  sessionStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  },
  location: { reload },
  fetch: entryGone,
};

const before = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const [name, value] of Object.entries(page)) {
    before.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
});
afterAll(() => {
  for (const [name, descriptor] of before)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
});

test("an update says nothing by itself; each failure it causes shows the notice, also after Dismiss", async () => {
  expect(CodeLoad.reloadForUpdate()).toBe(false);
  CodeLoad.checkBuild("/assets/index-new.js");
  await Promise.resolve();
  await Promise.resolve();
  expect(entryGone).toHaveBeenCalledTimes(1);
  expect(CodeLoad.notice()).toBeNull();

  CodeLoad.failed(new Error("chunk"));
  expect(CodeLoad.notice()).toBe("updated");
  CodeLoad.dismiss();
  expect(CodeLoad.notice()).toBeNull();
  CodeLoad.failed(new Error("chunk"));
  expect(CodeLoad.notice()).toBe("updated");
  CodeLoad.dismiss();
});

test("reloads for an update only while leaving loses nothing, and never twice from the same build", () => {
  const upload = LeaveGuard.hold();
  expect(CodeLoad.reloadForUpdate()).toBe(false);
  upload();

  // This page is what an earlier reload for an update landed on.
  stored.set("nimbus:update-reloaded-from", entry);
  expect(CodeLoad.reloadForUpdate()).toBe(false);
  expect(CodeLoad.reloading()).toBeUndefined();
  expect(reload).not.toHaveBeenCalled();

  stored.clear();
  expect(CodeLoad.reloadForUpdate()).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(stored.get("nimbus:update-reloaded-from")).toBe(entry);
  expect(CodeLoad.reloading()).toBeInstanceOf(Promise);
  // Asked again while it reloads, such as by the page that failed meanwhile, it reloads once.
  expect(CodeLoad.reloadForUpdate()).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
});
