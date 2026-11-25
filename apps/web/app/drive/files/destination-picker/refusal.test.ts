import { expect, it } from "bun:test";
import { BreadcrumbTrail } from "../breadcrumb-trail";
import { Refusal } from "./refusal";

it("keeps a refused folder open when it can lead to one that takes the items", () => {
  expect(Refusal.leadsOn("read-only")).toBe(true);
  expect(Refusal.leadsOn("already-there")).toBe(true);
  expect(Refusal.leadsOn("itself")).toBe(false);
  expect(Refusal.leadsOn("inside-itself")).toBe(false);
  expect(Refusal.labels["already-there"]).toBe("Already here");
});

it("calls the account's top folder and the drive root Files", () => {
  expect(BreadcrumbTrail.name("homes/alice", "homes/alice")).toBe("Files");
  expect(BreadcrumbTrail.name("", "homes/alice")).toBe("Files");
  expect(BreadcrumbTrail.name("homes/alice/inbox", "homes/alice")).toBe(
    "inbox",
  );
  expect(BreadcrumbTrail.name("projects", "")).toBe("projects");
});
