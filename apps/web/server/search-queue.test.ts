import { expect, test } from "bun:test";
import { SearchQueue } from "./search-queue";

test("takes callers' searches in turn, oldest first within each caller", () => {
  const queue = SearchQueue.create<string>();
  // One caller's burst arrives before anyone else's searches.
  for (let id = 1; id <= 4; id++) queue.add(id, "busy", `busy-${id}`);
  queue.add(5, "other", "other-5");
  queue.add(6, "third", "third-6");
  queue.add(7, "other", "other-7");
  const order: string[] = [];
  for (let next = queue.take(); next; next = queue.take())
    order.push(next.item);
  expect(order).toEqual([
    "busy-1",
    "other-5",
    "third-6",
    "busy-2",
    "other-7",
    "busy-3",
    "busy-4",
  ]);
  expect(queue.size).toBe(0);
});

test("drops a cancelled search before it runs", () => {
  const queue = SearchQueue.create<string>();
  queue.add(1, "a", "first");
  queue.add(2, "a", "second");
  queue.add(3, "b", "third");
  expect(queue.remove(1)).toBe(true);
  expect(queue.remove(3)).toBe(true);
  expect(queue.remove(9)).toBe(false);
  expect(queue.take()).toEqual({ id: 2, item: "second" });
  expect(queue.take()).toBeNull();
});
