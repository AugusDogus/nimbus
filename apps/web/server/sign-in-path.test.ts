import { expect, test } from "bun:test";
import { signInPath } from "./sign-in-path";

test("the sign-in address returns to the page asked for, on this site only", () => {
  expect(signInPath("/browse/a%20b?x=1")).toBe(
    "/login?callbackURL=%2Fbrowse%2Fa%2520b%3Fx%3D1",
  );
  expect(signInPath("/")).toBe("/login");
  expect(signInPath("//evil.example")).toBe("/login");
});
