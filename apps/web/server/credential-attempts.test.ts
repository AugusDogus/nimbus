import { expect, test } from "bun:test";
import { CredentialAttempts } from "./credential-attempts";

test("parallel wrong credentials from one client cannot all pass the limit", async () => {
  const attempts = CredentialAttempts.create("test-credentials-a", {
    limit: 5,
    windowMs: 60_000,
  });
  let verified = 0;
  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      attempts.run("client", async () => {
        verified += 1;
        await Bun.sleep(1);
        return null;
      }),
    ),
  );
  expect(verified).toBe(5);
  expect(results.filter((result) => result.kind === "rejected")).toHaveLength(
    5,
  );
  expect(results.filter((result) => result.kind === "throttled")).toHaveLength(
    45,
  );
});

test("right credentials are not counted and other clients are not slowed", async () => {
  const attempts = CredentialAttempts.create("test-credentials-b", {
    limit: 2,
    windowMs: 60_000,
  });
  for (let index = 0; index < 10; index++)
    expect(await attempts.run("client", async () => "account")).toEqual({
      kind: "verified",
      value: "account",
    });
  await attempts.run("client", async () => null);
  await attempts.run("client", async () => null);
  expect((await attempts.run("client", async () => "account")).kind).toBe(
    "throttled",
  );
  expect((await attempts.run("other", async () => "account")).kind).toBe(
    "verified",
  );
});
