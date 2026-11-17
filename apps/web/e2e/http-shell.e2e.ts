import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { client, test } from "./helpers";

const list = `/api/trpc/files.list?input=${encodeURIComponent(JSON.stringify({}))}`;

test("signed-in API responses are never stored by shared caches", async ({
  request,
}) => {
  const query = await request.get(list);
  expect(query.status()).toBe(200);
  expect(query.headers()["cache-control"]).toBe("private, no-store");

  const failed = await request.get("/api/trpc/files.nothing");
  expect(failed.status()).toBe(404);
  expect(failed.headers()["cache-control"]).toBe("private, no-store");

  // HEAD answers as GET would, without a body.
  const head = await request.head(list);
  expect(head.status()).toBe(200);
  expect(head.headers()["content-type"]).toContain("application/json");
  expect(head.headers()["cache-control"]).toBe("private, no-store");
});

test("percent-encoded server paths are not answered with the app", async ({
  request,
}) => {
  const document = { "Sec-Fetch-Dest": "document" };
  // `%61` is `a`, so this is the health endpoint itself.
  const health = await request.get("/%61pi/health", { headers: document });
  expect(health.status()).toBe(200);
  expect(health.headers()["content-type"]).toContain("application/json");
  const query = await request.get("/%61pi/trpc/files.list", {
    headers: document,
  });
  expect(query.headers()["content-type"]).toContain("application/json");
  // An encoded slash makes one segment, which no route has.
  const slash = await request.get("/api%2Fhealth", { headers: document });
  expect(slash.status()).toBe(404);
  expect(slash.headers()["content-type"]).toContain("text/plain");
});

test("responses honor encodings the client refuses with q=0", async ({
  request,
  context,
}) => {
  const refused = { "Accept-Encoding": "br;q=0, gzip;q=0, identity" };
  const page = await request.get("/login", { headers: refused });
  expect(page.headers()["content-encoding"]).toBeUndefined();
  const gzipOnly = await request.get("/login", {
    headers: { "Accept-Encoding": "br;q=0, gzip" },
  });
  expect(gzipOnly.headers()["content-encoding"]).toBe("gzip");

  // A listing large enough to be compressed.
  const folder = `encodings-${randomUUID()}`;
  const rpc = await client(context);
  await rpc.files.createFolder.mutate({ name: folder });
  for (let index = 0; index < 40; index++)
    await rpc.files.createFolder.mutate({
      name: `folder-with-a-long-name-${index}`,
      path: folder,
    });
  const listing = `/api/trpc/files.list?input=${encodeURIComponent(JSON.stringify({ path: folder }))}`;
  const compressed = await request.get(listing, {
    headers: { "Accept-Encoding": "gzip" },
  });
  expect(compressed.headers()["content-encoding"]).toBe("gzip");
  const api = await request.get(listing, { headers: refused });
  expect(api.headers()["content-encoding"]).toBeUndefined();
});
