import { expect, test } from "bun:test";
import { RetryAfter } from "./retry-after";

const throttled = (headers: HeadersInit) =>
  new Response(null, { status: 429, headers });

test("says the wait from Retry-After, or Better Auth's X-Retry-After, in words", () => {
  expect(RetryAfter.wait(throttled({ "Retry-After": "1" }))).toBe("1 second");
  expect(RetryAfter.wait(throttled({ "Retry-After": "59" }))).toBe(
    "59 seconds",
  );
  expect(RetryAfter.wait(throttled({ "Retry-After": "90" }))).toBe("2 minutes");
  expect(RetryAfter.wait(throttled({ "X-Retry-After": "60" }))).toBe(
    "1 minute",
  );
});

test("says a moment when the reply names no usable wait", () => {
  expect(RetryAfter.wait(throttled({}))).toBe("a moment");
  expect(RetryAfter.wait(throttled({ "Retry-After": "soon" }))).toBe(
    "a moment",
  );
  expect(RetryAfter.wait(throttled({ "Retry-After": "0" }))).toBe("a moment");
});
