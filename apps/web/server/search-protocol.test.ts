import { afterEach, expect, test } from "bun:test";
import { reconcileIntervalMs } from "./search-protocol";

const previous = process.env.NIMBUS_RECONCILE_INTERVAL_MS;
afterEach(() => {
  if (previous === undefined) delete process.env.NIMBUS_RECONCILE_INTERVAL_MS;
  else process.env.NIMBUS_RECONCILE_INTERVAL_MS = previous;
});

const interval = (value: string | undefined) => {
  if (value === undefined) delete process.env.NIMBUS_RECONCILE_INTERVAL_MS;
  else process.env.NIMBUS_RECONCILE_INTERVAL_MS = value;
  return reconcileIntervalMs();
};

test("the reconciliation interval defaults to 30 minutes and takes valid values", () => {
  expect(interval(undefined)).toBe(30 * 60_000);
  expect(interval("5000")).toBe(5000);
  expect(interval("not a number")).toBe(30 * 60_000);
  expect(interval("10")).toBe(30 * 60_000);
});

test("an interval longer than timers allow uses the default, not a 1 ms timer", () => {
  // Timers past 2^31 - 1 ms (about 24.8 days) fire after 1 ms instead, crawling nonstop.
  expect(interval(String(30 * 24 * 60 * 60_000))).toBe(30 * 60_000);
  expect(interval(String(2 ** 31 - 1))).toBe(2 ** 31 - 1);
});
