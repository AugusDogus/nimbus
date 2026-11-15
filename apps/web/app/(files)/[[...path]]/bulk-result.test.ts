import { expect, it } from "bun:test";
import { BulkResult } from "./bulk-result";

it("runs every item with bounded concurrency and reports failures by name", async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 40 }, (_, index) => ({ name: `item ${index}` }));
  const result = await BulkResult.run(items, async (item) => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(1);
    active--;
    if (item.name === "item 3" || item.name === "item 7") throw new Error("It is locked.");
  }, 4);
  expect(peak).toBe(4);
  expect(result.succeeded).toBe(38);
  expect(result.failed.map((failure) => failure.name).sort()).toEqual(["item 3", "item 7"]);
  expect(BulkResult.describe(result, "Moved")).toEqual({ ok: false, message: "Moved 38 of 40 items. “item 3”: It is locked. (and 1 more) Failed items were not changed." });
  expect(BulkResult.describe({ succeeded: 1, failed: [] }, "Moved")).toEqual({ ok: true, message: "Moved 1 item" });
  expect(BulkResult.describe({ succeeded: 0, failed: [{ name: "a", reason: "No access." }] }, "Moved", " to trash")).toEqual({ ok: false, message: "Nothing was moved to trash. “a”: No access. Failed items were not changed." });
  expect(BulkResult.describe({ succeeded: 3, failed: [] }, "Moved", " to trash")).toEqual({ ok: true, message: "Moved 3 items to trash" });
});
