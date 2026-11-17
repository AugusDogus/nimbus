import { randomUUID } from "node:crypto";
import {
  expect,
  type APIRequestContext,
  type BrowserContext,
} from "@playwright/test";
import { adminEmail, client, origin, test } from "./helpers";

async function davHeaders(context: BrowserContext) {
  const { token } = await (
    await client(context)
  ).appPasswords.create.mutate({
    name: `Bytes ${randomUUID()}`,
  });
  return {
    Authorization: `Basic ${Buffer.from(`${adminEmail}:${token}`).toString("base64")}`,
  };
}

/** A folder holding `keep.txt`, so a request that hits the folder by mistake is visible. */
async function davFolder(
  request: APIRequestContext,
  headers: Record<string, string>,
) {
  const folder = `bytes-${randomUUID()}`;
  expect(
    (
      await request.fetch(`/dav/${folder}`, { method: "MKCOL", headers })
    ).status(),
  ).toBe(201);
  expect(
    (
      await request.put(`/dav/${folder}/keep.txt`, { headers, data: "keep" })
    ).status(),
  ).toBe(201);
  return folder;
}

const exists = async (
  request: APIRequestContext,
  headers: Record<string, string>,
  path: string,
) => (await request.get(path, { headers })).status() === 200;

test("WebDAV refuses a request target with an unencoded ? instead of acting on the parent", async ({
  context,
  request,
}) => {
  const headers = await davHeaders(context);
  const folder = await davFolder(request, headers);
  for (const method of [
    "DELETE",
    "PUT",
    "MKCOL",
    "LOCK",
    "PROPPATCH",
    "MOVE",
  ]) {
    const response = await request.fetch(`/dav/${folder}/?x.txt`, {
      method,
      headers: { ...headers, Destination: `${origin}/dav/${folder}-moved` },
      data: "",
    });
    expect(response.status(), method).toBe(400);
  }
  expect(await exists(request, headers, `/dav/${folder}/keep.txt`)).toBe(true);
});

test("WebDAV refuses a Destination or If resource with # or ? instead of replacing the parent", async ({
  context,
  request,
}) => {
  const headers = await davHeaders(context);
  const folder = await davFolder(request, headers);
  await request.put(`/dav/${folder}/report.txt`, { headers, data: "report" });
  await request.fetch(`/dav/${folder}/sub`, { method: "MKCOL", headers });
  await request.put(`/dav/${folder}/sub/keep.txt`, { headers, data: "keep" });
  for (const [method, destination] of [
    ["MOVE", `${origin}/dav/${folder}/sub/#1 report.txt`],
    ["COPY", `/dav/${folder}/sub/?.txt`],
  ] as const) {
    const response = await request.fetch(`/dav/${folder}/report.txt`, {
      method,
      headers: { ...headers, Destination: destination },
    });
    expect(response.status(), method).toBe(400);
  }
  const tagged = await request.fetch(`/dav/${folder}/report.txt`, {
    method: "DELETE",
    headers: {
      ...headers,
      If: `<${origin}/dav/${folder}/?x> (Not <DAV:no-lock>)`,
    },
  });
  expect(tagged.status()).toBe(400);
  expect(await exists(request, headers, `/dav/${folder}/sub/keep.txt`)).toBe(
    true,
  );
  expect(await exists(request, headers, `/dav/${folder}/report.txt`)).toBe(
    true,
  );
});

test("link password endpoints refuse oversized bodies before reading them", async ({
  context,
  browser,
}) => {
  const rpc = await client(context);
  const share = await rpc.shares.create.mutate({
    path: "alpha.txt",
    expiresAt: null,
    password: "correct-horse-42",
  });
  const fileRequest = await rpc.fileRequests.create.mutate({
    path: "docs",
    note: "",
    expiresAt: null,
    maxFileBytes: null,
    maxFiles: null,
    maxTotalBytes: null,
    password: "correct-horse-42",
  });
  const anonymous = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const big = JSON.stringify({
      password: "x",
      padding: "y".repeat(64 * 1024),
    });
    for (const url of [
      `/api/share/${share.token}`,
      `/api/file-request/${fileRequest.token}`,
    ]) {
      const response = await anonymous.request.post(url, {
        headers: { "Content-Type": "application/json" },
        data: big,
      });
      expect(response.status(), url).toBe(413);
      const ok = await anonymous.request.post(url, {
        data: { password: "correct-horse-42" },
      });
      expect(ok.status(), url).toBe(200);
    }
    const trpc = await anonymous.request.post("/api/trpc/shares.list", {
      headers: { "Content-Type": "application/json" },
      data: "y".repeat(2 * 1024 * 1024),
    });
    expect(trpc.status()).toBe(413);
  } finally {
    await anonymous.close();
  }
});
