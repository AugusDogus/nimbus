import { describe, expect, it } from "bun:test";
import { Landing } from "./landing";

const admin = { isAdmin: true, home: "users/admin", top: "" };
const homeOnly = { isAdmin: false, home: "users/ann", top: "users/ann" };
const shared = { isAdmin: false, home: "users/sam", top: "" };
const homeless = { isAdmin: false, home: null, top: "" };

describe("where an account starts", () => {
  it("signs administrators in at the drive root and everyone else in their home", () => {
    expect(Landing.afterSignIn(admin)).toBe("");
    expect(Landing.afterSignIn(homeOnly)).toBe("users/ann");
    expect(Landing.afterSignIn(shared)).toBe("users/sam");
    expect(Landing.afterSignIn(homeless)).toBe("");
  });

  it("sends / to the home only for an account that reaches nothing outside it", () => {
    expect(Landing.rootRedirect(admin)).toBeNull();
    expect(Landing.rootRedirect(homeOnly)).toBe("users/ann");
    expect(Landing.rootRedirect(shared)).toBeNull();
    expect(Landing.rootRedirect(homeless)).toBeNull();
  });
});
