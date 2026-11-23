import { describe, expect, it } from "bun:test";
import { SignOut } from "./sign-out";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("SignOut.confirmed", () => {
  it("accepts the auth server's confirmation", async () => {
    expect(await SignOut.confirmed(json({ success: true }))).toBe(true);
  });

  it("refuses a sign-in page answered with 200, such as from a proxy", async () => {
    expect(
      await SignOut.confirmed(
        new Response('<!doctype html><form action="/login"></form>', {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      ),
    ).toBe(false);
  });

  it("refuses JSON that does not confirm", async () => {
    expect(await SignOut.confirmed(json({ success: false }))).toBe(false);
    expect(await SignOut.confirmed(json({}))).toBe(false);
    expect(await SignOut.confirmed(json({ success: true }, 500))).toBe(false);
  });

  it("refuses a body that is not JSON though it says so", async () => {
    expect(
      await SignOut.confirmed(
        new Response("<html>", {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ).toBe(false);
  });
});
