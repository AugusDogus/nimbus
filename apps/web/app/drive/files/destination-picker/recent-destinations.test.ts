import { expect, it } from "bun:test";
import {
  RECENT_LIMIT,
  RecentDestinations,
  type RecentStorage,
} from "./recent-destinations";

const memory = (): RecentStorage & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
};

it("keeps the newest destinations first, once each, per account", () => {
  const storage = memory();
  RecentDestinations.record("a", "archive", storage);
  RecentDestinations.record("a", "projects", storage);
  RecentDestinations.record("a", "archive", storage);
  RecentDestinations.record("b", "elsewhere", storage);
  expect(RecentDestinations.list("a", storage)).toEqual([
    "archive",
    "projects",
  ]);
  expect(RecentDestinations.list("b", storage)).toEqual(["elsewhere"]);
  RecentDestinations.forget("a", "archive", storage);
  expect(RecentDestinations.list("a", storage)).toEqual(["projects"]);
});

it("keeps a bounded list", () => {
  const storage = memory();
  for (let index = 0; index < RECENT_LIMIT + 5; index++)
    RecentDestinations.record("a", `folder ${index}`, storage);
  const paths = RecentDestinations.list("a", storage);
  expect(paths).toHaveLength(RECENT_LIMIT);
  expect(paths[0]).toBe(`folder ${RECENT_LIMIT + 4}`);
});

it("reads nothing from damaged or missing storage", () => {
  const storage = memory();
  storage.items.set("nimbus:recent-destinations:a", "{not json");
  expect(RecentDestinations.list("a", storage)).toEqual([]);
  storage.items.set("nimbus:recent-destinations:a", JSON.stringify([1, "ok"]));
  expect(RecentDestinations.list("a", storage)).toEqual(["ok"]);
  expect(RecentDestinations.list("a", null)).toEqual([]);
  const refusing: RecentStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  expect(() => RecentDestinations.record("a", "x", refusing)).not.toThrow();
});
