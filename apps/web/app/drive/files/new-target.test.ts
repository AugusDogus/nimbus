import { describe, expect, it } from "bun:test";
import { NewTarget } from "./new-target";

describe("NewTarget", () => {
  it("creates in the folder shown, when it can", () => {
    expect(
      NewTarget.resolve({ page: "folder", path: "a/b", canWrite: true }),
    ).toEqual({ kind: "folder", path: "a/b" });
  });

  it("explains a folder that can only be viewed, and waits for its answer", () => {
    expect(
      NewTarget.resolve({ page: "folder", path: "a", canWrite: false }),
    ).toEqual({ kind: "none", reason: NewTarget.reasons.viewOnlyFolder });
    expect(
      NewTarget.resolve({ page: "folder", path: "a", canWrite: undefined }),
    ).toEqual({ kind: "pending" });
  });

  it("creates in the folder Files opens, off a folder", () => {
    expect(
      NewTarget.resolve({
        page: "other",
        top: { path: "", canWrite: true },
        home: { path: "users/sam", canWrite: true },
      }),
    ).toEqual({ kind: "home", path: "" });
  });

  it("creates in the home folder where Files opens a root it cannot add to", () => {
    expect(
      NewTarget.resolve({
        page: "other",
        top: { path: "", canWrite: false },
        home: { path: "users/sam", canWrite: true },
      }),
    ).toEqual({ kind: "home", path: "users/sam" });
  });

  it("explains an account with no folder to add to", () => {
    const none: NewTarget = {
      kind: "none",
      reason: NewTarget.reasons.viewOnlyAccount,
    };
    expect(
      NewTarget.resolve({
        page: "other",
        top: { path: "", canWrite: false },
        home: null,
      }),
    ).toEqual(none);
    expect(
      NewTarget.resolve({
        page: "other",
        top: { path: "users/sam", canWrite: false },
        home: { path: "users/sam", canWrite: false },
      }),
    ).toEqual(none);
  });

  it("waits for the answers it needs, and no others", () => {
    expect(
      NewTarget.resolve({
        page: "other",
        top: { path: "", canWrite: undefined },
        home: { path: "users/sam", canWrite: true },
      }),
    ).toEqual({ kind: "pending" });
    expect(
      NewTarget.resolve({
        page: "other",
        top: { path: "", canWrite: false },
        home: { path: "users/sam", canWrite: undefined },
      }),
    ).toEqual({ kind: "pending" });
    expect(
      NewTarget.resolve({
        page: "other",
        top: { path: "", canWrite: true },
        home: { path: "users/sam", canWrite: undefined },
      }),
    ).toEqual({ kind: "home", path: "" });
  });
});
