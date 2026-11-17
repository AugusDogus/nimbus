import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { createTestAuth, type TestAuth } from "./auth-testing";

let t: TestAuth;
beforeEach(async () => {
  t = await createTestAuth();
});
afterEach(async () => {
  await t.close();
});

/** RFC 4648 base32, as authenticator apps read the secret from the otpauth URI. */
const fromBase32 = (text: string) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of text.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
};

/** What an authenticator app shows for `secret` at `time` (RFC 6238, 30 s steps, 6 digits). */
const authenticatorCode = (secret: string, time = Date.now()) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = createHmac("sha1", fromBase32(secret))
    .update(counter)
    .digest();
  const offset = (digest.at(-1) ?? 0) & 0xf;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
};

/** Turns on two-factor authentication for a new account and returns its secret and recovery codes. */
async function enrolledAccount() {
  const account = await t.createUser("first@example.test");
  const enabled = await t.request("POST", "/two-factor/enable", {
    cookie: account.cookie,
    body: { password: t.password },
  });
  expect(enabled.status).toBe(200);
  const { totpURI, backupCodes } = z
    .object({ totpURI: z.string(), backupCodes: z.array(z.string()) })
    .parse(await enabled.json());
  const secret = z.string().parse(new URL(totpURI).searchParams.get("secret"));
  const confirmed = await t.request("POST", "/two-factor/verify-totp", {
    cookie: account.cookie,
    body: { code: authenticatorCode(secret) },
  });
  expect(confirmed.status).toBe(200);
  return { ...account, secret, backupCodes };
}

/** A password sign-in that stops at the second-factor challenge; returns its cookie. */
async function challenge(ip: string) {
  const response = await t.request("POST", "/sign-in/email", {
    body: { email: "first@example.test", password: t.password },
    ip,
  });
  expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
  return t.cookieFrom(response);
}

describe("recovery codes", () => {
  test("one recovery code completes one sign-in, even when sent twice at once", async () => {
    const { backupCodes } = await enrolledAccount();
    const code = z.string().parse(backupCodes[0]);
    const [first, second] = [
      await challenge("198.18.2.1"),
      await challenge("198.18.2.2"),
    ];
    const responses = await Promise.all(
      [first, second].map((cookie, index) =>
        t.request("POST", "/two-factor/verify-backup-code", {
          cookie,
          body: { code },
          ip: `198.18.2.${index + 1}`,
        }),
      ),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
  });
});

describe("authenticator codes", () => {
  const verify = (cookie: string, code: string, ip: string) =>
    t.request("POST", "/two-factor/verify-totp", {
      cookie,
      body: { code },
      ip,
    });

  test("one authenticator code completes one sign-in", async () => {
    const { secret } = await enrolledAccount();
    const code = authenticatorCode(secret, Date.now() + 30_000);
    const first = await challenge("198.18.3.1");
    expect((await verify(first, code, "198.18.3.1")).status).toBe(200);
    const second = await challenge("198.18.3.2");
    const replayed = await verify(second, code, "198.18.3.2");
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toMatchObject({ code: "TOTP_ALREADY_USED" });
    // The authenticator's next code still works.
    expect(
      (
        await verify(
          second,
          authenticatorCode(secret, Date.now() - 30_000),
          "198.18.3.2",
        )
      ).status,
    ).toBe(200);
  });

  test("the code that confirmed the authenticator cannot sign in", async () => {
    const { secret } = await enrolledAccount();
    const replayed = await verify(
      await challenge("198.18.3.3"),
      authenticatorCode(secret),
      "198.18.3.3",
    );
    expect(replayed.status).toBe(401);
  });

  test("one code sent to two sign-ins at once completes one", async () => {
    const { secret } = await enrolledAccount();
    const code = authenticatorCode(secret, Date.now() + 30_000);
    const challenges = [
      await challenge("198.18.3.4"),
      await challenge("198.18.3.5"),
    ];
    const statuses = (
      await Promise.all(
        challenges.map((cookie, index) =>
          verify(cookie, code, `198.18.3.${index + 4}`),
        ),
      )
    ).map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
  });

  test("a wrong code does not use up the right one", async () => {
    const { secret } = await enrolledAccount();
    const cookie = await challenge("198.18.3.6");
    const right = authenticatorCode(secret, Date.now() + 30_000);
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
    expect((await verify(cookie, wrong, "198.18.3.6")).status).toBe(401);
    expect((await verify(cookie, right, "198.18.3.6")).status).toBe(200);
  });
});
