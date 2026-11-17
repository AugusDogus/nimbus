import { expect, test } from "bun:test";
import { RequestOrigin } from "./request-origin";

const allowed = new Set([
  "https://files.example.test",
  "https://nas.local:8443",
]);
const post = (headers: Record<string, string>) =>
  new Request("https://files.example.test/api/backups", {
    method: "POST",
    headers,
  });
const fromNimbus = (headers: Record<string, string>) =>
  RequestOrigin.fromNimbus(post(headers), allowed);

test("a post from another site or a sibling subdomain is refused", () => {
  expect(fromNimbus({ "sec-fetch-site": "cross-site" })).toBe(false);
  expect(fromNimbus({ "sec-fetch-site": "same-site" })).toBe(false);
  expect(fromNimbus({ origin: "https://evil.example" })).toBe(false);
  expect(fromNimbus({ origin: "null" })).toBe(false);
});

test("Nimbus pages, trusted origins and clients that are not browsers are allowed", () => {
  expect(fromNimbus({ "sec-fetch-site": "same-origin", origin: "null" })).toBe(
    true,
  );
  expect(fromNimbus({ origin: "https://nas.local:8443" })).toBe(true);
  expect(fromNimbus({})).toBe(true);
});
