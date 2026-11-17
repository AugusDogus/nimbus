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
