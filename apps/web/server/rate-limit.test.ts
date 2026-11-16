import { describe, expect, it } from "bun:test";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  const rule = { limit: 5, windowMs: 60_000 };

  it("allows a burst up to the limit, then reports when to retry", () => {
    const limiter = RateLimiter.create(rule);
    for (let attempt = 0; attempt < 5; attempt++)
      expect(limiter.consume("a", 0)).toEqual({ allowed: true });
    expect(limiter.consume("a", 0)).toEqual({
      allowed: false,
      retryAfterSeconds: 12,
    });
    expect(limiter.consume("b", 0)).toEqual({ allowed: true });
  });

  it("refills smoothly over the window", () => {
    const limiter = RateLimiter.create(rule);
    for (let attempt = 0; attempt < 5; attempt++) limiter.consume("a", 0);
    expect(limiter.check("a", 11_999).allowed).toBe(false);
    expect(limiter.consume("a", 12_000)).toEqual({ allowed: true });
    expect(limiter.check("a", 12_000).allowed).toBe(false);
  });

  it("checks without counting", () => {
    const limiter = RateLimiter.create(rule);
    for (let attempt = 0; attempt < 20; attempt++)
      expect(limiter.check("a", 0)).toEqual({ allowed: true });
    expect(limiter.size).toBe(0);
  });

  it("bounds memory by expiring idle keys, then the oldest", () => {
    const limiter = RateLimiter.create(rule, 3);
    limiter.consume("a", 0);
    limiter.consume("b", 0);
    limiter.consume("c", 0);
    limiter.consume("d", 100_000);
    expect(limiter.size).toBe(1);
    limiter.consume("e", 100_000);
    limiter.consume("f", 100_000);
    limiter.consume("g", 100_000);
    expect(limiter.size).toBe(3);
    expect(limiter.check("d", 100_000)).toEqual({ allowed: true });
  });
});
