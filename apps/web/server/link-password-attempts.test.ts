import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { clientIpHeader } from "./client-ip";
import { LinkPasswordAttempts } from "./link-password-attempts";

const from = (ip: string) =>
  new Request("http://localhost/api/share/x", {
    method: "POST",
    headers: { [clientIpHeader]: ip },
  });

const fresh = (options?: Parameters<typeof LinkPasswordAttempts.create>[1]) =>
  LinkPasswordAttempts.create(`test-${randomUUID()}`, options);

test("counts an attempt before the password is verified, so parallel guesses are limited", async () => {
  const attempts = fresh();
  // Forty guesses in flight at once: every one is admitted or refused before any hash finishes.
  const results = await Promise.all(
    Array.from({ length: 40 }, () =>
      attempts.begin("link", from("203.0.113.7")),
    ),
  );
  expect(results.filter((result) => result.kind === "admitted")).toHaveLength(
    10,
  );
  expect(results.filter((result) => result.kind === "refused")).toHaveLength(
    30,
  );
});

test("a correct password gives its attempt back", async () => {
  const attempts = fresh();
  for (let index = 0; index < 20; index++) {
    const attempt = await attempts.begin("link", from("203.0.113.8"));
    if (attempt.kind !== "admitted")
      throw new Error(`attempt ${index} was refused`);
    attempt.succeeded();
  }
});

test("guesses spread over many addresses slow the link down but never refuse a correct password", async () => {
  const waits: number[] = [];
  const attempts = fresh({
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  // Five addresses use up the link's hourly budget of wrong guesses.
  for (let address = 0; address < 5; address++)
    for (let guess = 0; guess < 10; guess++)
      expect(
        (await attempts.begin("link", from(`198.51.100.${address}`))).kind,
      ).toBe("admitted");
  // The owner's correct password from a new address still gets checked, after a short wait.
  const owner = await attempts.begin("link", from("192.0.2.1"));
  expect(owner.kind).toBe("admitted");
  expect(waits.length).toBe(1);
  // Over budget, attempts on the link are spaced out, so the guess rate stays bounded.
  const next = await attempts.begin("link", from("192.0.2.2"));
  expect(next.kind).toBe("admitted");
  expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
});

test("over budget, a link refuses attempts that would wait too long", async () => {
  const attempts = fresh({ sleep: async () => {} });
  for (let address = 0; address < 5; address++)
    for (let guess = 0; guess < 10; guess++)
      await attempts.begin("link", from(`198.51.100.${address}`));
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      attempts.begin("link", from(`192.0.2.${index}`)),
    ),
  );
  const refused = results.filter((result) => result.kind === "refused");
  expect(refused.length).toBeGreaterThan(0);
  expect(
    results.filter((result) => result.kind === "admitted").length,
  ).toBeGreaterThan(0);
  // Another link is unaffected.
  expect((await attempts.begin("other", from("192.0.2.200"))).kind).toBe(
    "admitted",
  );
});
