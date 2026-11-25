import { expect, test } from "bun:test";
import { TrashOrder } from "./trash-order";

const items = [
  { id: "1", path: "x/beta.txt", deletedAt: 2, expiresAt: 30 },
  { id: "2", path: "alpha.txt", deletedAt: 3, expiresAt: 10 },
  { id: "3", path: "y/z/gamma", deletedAt: 1, expiresAt: 20 },
];
const ids = (sort: string | undefined) =>
  TrashOrder.apply(items, TrashOrder.pick(sort)).map((item) => item.id);

test("Trash shows the most recently deleted first, and sorts by expiry or by the item's own name", () => {
  expect(ids(undefined)).toEqual(["2", "1", "3"]);
  expect(TrashOrder.param(TrashOrder.pick(undefined))).toBe(undefined);
  expect(ids("deleted-asc")).toEqual(["3", "1", "2"]);
  expect(ids("expires-asc")).toEqual(["2", "3", "1"]);
  expect(ids("name-asc")).toEqual(["2", "1", "3"]);
  expect(ids("name-desc")).toEqual(["3", "1", "2"]);
});
