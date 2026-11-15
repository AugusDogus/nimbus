import { expect, it } from "bun:test";
import { coalesce } from "./coalesce";

it("runs immediately, then at most once per interval with the latest burst", async () => {
  let runs = 0;
  const trigger = coalesce(() => runs++, 30);
  trigger();
  expect(runs).toBe(1);
  trigger();
  trigger();
  trigger();
  expect(runs).toBe(1);
  await Bun.sleep(45);
  expect(runs).toBe(2);
  await Bun.sleep(45);
  expect(runs).toBe(2);
  trigger.cancel();
  trigger();
  expect(runs).toBe(3);
  trigger();
  trigger.cancel();
  await Bun.sleep(45);
  expect(runs).toBe(3);
});
