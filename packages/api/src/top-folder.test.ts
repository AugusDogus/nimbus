import { describe, expect, it } from "bun:test";
import type { Grant, Permission } from "./drive-store";
import { TopFolder } from "./top-folder";

const grant = (path: string, permission: Permission = "read"): Grant => ({
  id: `grant-${path}`,
  path,
  subject: { type: "user", id: "member" },
  permission,
});
const home = "users/member";
const member = (...paths: string[]) => ({
  isAdmin: false,
  grants: [grant(home, "admin"), ...paths.map((path) => grant(path))],
});

describe("the folder Files opens", () => {
  it("is the drive root for administrators, home or not", () => {
    expect(TopFolder.of({ isAdmin: true, grants: [] }, "users/admin")).toBe("");
    expect(TopFolder.of({ isAdmin: true, grants: [] }, null)).toBe("");
  });

  it("is the home folder for an account that reaches nothing outside it", () => {
    expect(TopFolder.of(member(), home)).toBe(home);
    expect(TopFolder.of(member(`${home}/photos`), home)).toBe(home);
  });

  it("is the drive root once anything outside the home is shared with the account", () => {
    expect(TopFolder.of(member("team"), home)).toBe("");
    expect(TopFolder.of(member("documents/team/reports"), home)).toBe("");
    // Inside someone else's home, the folder holding the homes, or a home whose name extends it.
    expect(TopFolder.of(member("users/alice/notes"), home)).toBe("");
    expect(TopFolder.of(member("users"), home)).toBe("");
    expect(TopFolder.of(member("users/member2"), home)).toBe("");
  });

  it("is the drive root for an account without a home", () => {
    expect(TopFolder.of({ isAdmin: false, grants: [] }, null)).toBe("");
    expect(
      TopFolder.of({ isAdmin: false, grants: [grant("team")] }, null),
    ).toBe("");
  });
});
