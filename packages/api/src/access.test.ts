import { describe, expect, it } from "bun:test";
import { accessFor, canAccess } from "./access";
import type { Grant } from "./drive-store";

const grants: Grant[] = [{ id: "grant", subject: { type: "user", id: "reader" }, path: "docs", permission: "read" }];

describe("allow-only path permissions", () => {
  it("inherits at path boundaries without granting writes or similarly named siblings", () => {
    expect(canAccess(grants, "docs/report.txt", "read")).toBe(true);
    expect(canAccess(grants, "docs/report.txt", "write")).toBe(false);
    expect(canAccess(grants, "docs-private/report.txt", "read")).toBe(false);
    expect(canAccess(grants, "", "read")).toBe(false);
  });
  it("allows navigation to a grant without exposing other content", () => {
    const access = accessFor({ id: "reader", name: "Reader", email: "r@example.test", role: "user", banned: false }, grants);
    expect(access.canBrowse("")).toBe(true);
    expect(access.canBrowse("private")).toBe(false);
    expect(() => access.require("docs", "write")).toThrow();
  });
  it("keeps stronger inherited permissions when a narrower grant exists", () => {
    expect(canAccess([...grants, { id: "root", subject: { type: "group", id: "team" }, path: "", permission: "write" }], "docs", "write")).toBe(true);
  });
});
