import { describe, expect, it } from "bun:test";
import { accessFor, canAccess } from "./access";
import type { Grant } from "./drive-store";

const grants: Grant[] = [
  {
    id: "grant",
    subject: { type: "user", id: "reader" },
    path: "docs",
    permission: "read",
  },
];

describe("allow-only path permissions", () => {
  it("inherits at path boundaries without granting writes or similarly named siblings", () => {
    expect(canAccess(grants, "docs/report.txt", "read")).toBe(true);
    expect(canAccess(grants, "docs/report.txt", "write")).toBe(false);
    expect(canAccess(grants, "docs-private/report.txt", "read")).toBe(false);
    expect(canAccess(grants, "", "read")).toBe(false);
  });
  it("allows navigation to a grant without exposing other content", () => {
    const access = accessFor(
      {
        id: "reader",
        name: "Reader",
        email: "r@example.test",
        role: "user",
        banned: false,
      },
      grants,
    );
    expect(access.canBrowse("")).toBe(true);
    expect(access.canBrowse("private")).toBe(false);
    expect(() => access.require("docs", "write")).toThrow();
  });
  it("keeps stronger inherited permissions when a narrower grant exists", () => {
    expect(
      canAccess(
        [
          ...grants,
          {
            id: "root",
            subject: { type: "group", id: "team" },
            path: "",
            permission: "write",
          },
        ],
        "docs",
        "write",
      ),
    ).toBe(true);
  });
});

describe("indexed grant checks", () => {
  const user = {
    id: "reader",
    name: "Reader",
    email: "r@example.test",
    role: "user",
    banned: false,
  };
  const grant = (path: string, permission: Grant["permission"]): Grant => ({
    id: `${path}:${permission}`,
    subject: { type: "user", id: "reader" },
    path,
    permission,
  });
  it("matches a linear scan of every grant for every path and permission", () => {
    const grants = [
      grant("a", "read"),
      grant("a/b", "write"),
      grant("a/b/c", "read"),
      grant("x/y", "admin"),
      grant("a b/😀", "write"),
    ];
    const access = accessFor(user, grants);
    const rank = { read: 1, write: 2, admin: 3 } as const;
    const within = (parent: string, child: string) =>
      parent === "" || parent === child || child.startsWith(`${parent}/`);
    for (const path of [
      "",
      "a",
      "a/b",
      "a/b/c/d",
      "ab",
      "a/bc",
      "x",
      "x/y/z",
      "a b/😀/f",
      "a b",
    ])
      for (const permission of ["read", "write", "admin"] as const) {
        const expected = grants.some(
          (entry) =>
            within(entry.path, path) &&
            rank[entry.permission] >= rank[permission],
        );
        expect({
          path,
          permission,
          allowed: access.can(path, permission),
        }).toEqual({
          path,
          permission,
          allowed: expected,
        });
      }
    for (const path of ["", "a", "x", "x/y", "a b", "a/b/c", "q", "x/q"])
      expect({ path, browse: access.canBrowse(path) }).toEqual({
        path,
        browse:
          path === "" ||
          grants.some(
            (entry) => within(path, entry.path) || within(entry.path, path),
          ),
      });
  });
  it("reuses access while the store's epoch is unchanged", async () => {
    let epoch = 1;
    let loads = 0;
    const { createTestDriveStore } = await import("./testing");
    const base = createTestDriveStore().store;
    const store = {
      ...base,
      accessEpoch: async () => epoch,
      getUser: async (id: string) => {
        loads++;
        return base.getUser(id);
      },
    };
    const { getAccess } = await import("./access");
    await getAccess(store, "reader");
    await getAccess(store, "reader");
    expect(loads).toBe(1);
    epoch++;
    await getAccess(store, "reader");
    expect(loads).toBe(2);
  });
});
