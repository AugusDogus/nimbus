import { expect, test } from "bun:test";
import { FileUpdates } from "./file-updates";

test("a change refreshes listings, and a resync refreshes everything derived from files, once per burst", () => {
  const refreshed: string[][] = [];
  const resyncs: boolean[] = [];
  const updates = FileUpdates.collector((keys, resync) => {
    refreshed.push(keys);
    resyncs.push(resync);
  });
  updates.add({ kind: "delta" });
  updates.add({ kind: "delta" });
  updates.add({ kind: "resync" });
  updates.add({ kind: "resync" });
  expect(refreshed).toEqual([]);
  updates.flush();
  expect(refreshed).toEqual([
    [
      "files.list",
      "files.storage",
      "catalog",
      "trash",
      "shares",
      "file-requests",
      "permissions",
      "preview",
      "versions",
    ],
  ]);
  updates.add({ kind: "delta" });
  updates.flush();
  updates.flush();
  expect(refreshed.at(-1)).toEqual(["files.list", "files.storage", "catalog"]);
  expect(refreshed).toHaveLength(2);
  // A resync refetches even queries already fetching, whose answers may predate it.
  expect(resyncs).toEqual([true, false]);
});
