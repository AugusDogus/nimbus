import { open } from "node:fs/promises";

/**
 * For tests of races: runs `run` once around the `call`-th call (from 1) of `method` on any
 * open file handle, `before` it starts or `after` it resolves, so a write or an abort lands
 * exactly between two steps of the code under test. Returns a function that removes the hook;
 * call it in `finally`.
 */
export async function hookFileHandle(
  method: "read" | "stat",
  when: "before" | "after",
  call: number,
  run: () => Promise<void> | void,
) {
  const probe = await open(import.meta.path);
  const prototype: unknown = Object.getPrototypeOf(probe);
  await probe.close();
  if (typeof prototype !== "object" || prototype === null)
    throw new Error("Bun's FileHandle has no prototype to hook.");
  const original: unknown = Reflect.get(prototype, method);
  if (typeof original !== "function")
    throw new Error(`Bun's FileHandle has no ${method} method to hook.`);
  let calls = 0;
  const restore = () => Reflect.set(prototype, method, original);
  Reflect.set(
    prototype,
    method,
    async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      calls++;
      if (calls !== call) {
        const result: unknown = await Reflect.apply(original, this, args);
        return result;
      }
      restore();
      if (when === "before") await run();
      const result: unknown = await Reflect.apply(original, this, args);
      if (when === "after") await run();
      return result;
    },
  );
  return restore;
}
