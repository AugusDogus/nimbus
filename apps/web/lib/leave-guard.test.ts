import { expect, test } from "bun:test";
import { LeaveGuard } from "./leave-guard";

const leavingAsks = () =>
  !dispatchEvent(new Event("beforeunload", { cancelable: true }));

test("asks before leaving while any hold lasts, and says the page is busy", () => {
  expect(LeaveGuard.busy()).toBe(false);
  expect(leavingAsks()).toBe(false);
  const upload = LeaveGuard.hold();
  const transfer = LeaveGuard.hold();
  expect(LeaveGuard.busy()).toBe(true);
  expect(leavingAsks()).toBe(true);
  upload();
  // Releasing twice changes nothing; the transfer still holds the page.
  upload();
  expect(leavingAsks()).toBe(true);
  transfer();
  expect(LeaveGuard.busy()).toBe(false);
  expect(leavingAsks()).toBe(false);
});
