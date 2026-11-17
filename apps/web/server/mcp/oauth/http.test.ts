import { afterEach, expect, test } from "bun:test";
import type { Database as SQLite } from "bun:sqlite";
import { createTestDatabase } from "../../db/testing";
import { decideConsent } from "./authorization";
import { readForm, readJsonObject } from "./http";

const origin = "https://files.example.test";
const chunk = 16 * 1024;

/** A chunked body with no Content-Length that would stream 64 MiB, counting what is read. */
function hugeChunkedBody() {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk;
      controller.enqueue(new Uint8Array(chunk).fill(0x61));
      if (pulled >= 64 * 1024 * 1024) controller.close();
    },
  });
  return { stream, pulled: () => pulled };
}

const post = (path: string, contentType: string, body: ReadableStream) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": contentType, origin },
    body,
  });

let opened: SQLite | null = null;
afterEach(() => {
  opened?.close();
  opened = null;
});

test("form and JSON bodies stop being read once they pass 64 KiB", async () => {
  for (const [read, contentType] of [
    [readForm, "application/x-www-form-urlencoded"],
    [readJsonObject, "application/json"],
  ] as const) {
    const body = hugeChunkedBody();
    const result = await read(post("/oauth/token", contentType, body.stream));
    expect(result).toMatchObject({ ok: false, error: { status: 413 } });
    expect(body.pulled()).toBeLessThanOrEqual(64 * 1024 + 4 * chunk);
  }
});

test("the consent decision stops reading its body once it passes 64 KiB", async () => {
  const { sqlite, db } = createTestDatabase();
  opened = sqlite;
  const body = hugeChunkedBody();
  const response = await decideConsent(
    {
      db,
      origin,
      secret: "test-secret-that-is-at-least-32-characters-long",
      now: Date.now,
      getSession: async () => null,
    },
    post(
      "/oauth/consent/decision",
      "application/x-www-form-urlencoded",
      body.stream,
    ),
  );
  expect(response.status).toBe(413);
  expect(body.pulled()).toBeLessThanOrEqual(64 * 1024 + 4 * chunk);
});

test("small bodies are still read", async () => {
  const result = await readForm(
    new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", é: "ü" }),
    }),
  );
  expect(result).toEqual({
    ok: true,
    value: new Map([
      ["grant_type", "refresh_token"],
      ["é", "ü"],
    ]),
  });
});
