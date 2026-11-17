import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  expect,
  type APIRequestContext,
  type BrowserContext,
} from "@playwright/test";
import { adminEmail, client, login, origin, password, test } from "./helpers";

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
    // A declared length over the cap is refused before a byte is read, so nothing is sent.
    const trpc = await new Promise<number | undefined>((resolve, reject) => {
      const sent = httpRequest(
        `${origin}/api/trpc/shares.create`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(64 * 1024 * 1024),
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
          sent.destroy();
        },
      );
      sent.on("error", reject);
      sent.flushHeaders();
    });
    expect(trpc).toBe(413);
  } finally {
    await anonymous.close();
  }
});

test("parallel wrong passwords are counted before they are checked", async ({
  context,
  browser,
}) => {
  const share = await (
    await client(context)
  ).shares.create.mutate({
    path: "alpha.txt",
    expiresAt: null,
    password: "correct-horse-42",
  });
  const anonymous = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    const statuses = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        anonymous.request
          .post(`/api/share/${share.token}`, {
            data: { password: `wrong-guess-${index}` },
          })
          .then((response) => response.status()),
      ),
    );
    expect(statuses.filter((status) => status === 401)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(20);
  } finally {
    await anonymous.close();
  }
});

test("a link's download limit counts ranges that do not continue a counted download", async ({
  context,
  browser,
}) => {
  const share = await (
    await client(context)
  ).shares.create.mutate({
    path: "alpha.txt",
    expiresAt: null,
    maxDownloads: 2,
  });
  const url = `/api/share/${share.token}?download=1`;
  const visitor = () =>
    browser.newContext({ storageState: { cookies: [], origins: [] } });
  const first = await visitor();
  const second = await visitor();
  try {
    // Loading the share page (GET and HEAD) uses up nothing.
    for (let load = 0; load < 3; load++)
      expect((await first.request.get(`/s/${share.token}`)).status()).toBe(200);
    expect((await first.request.head(`/s/${share.token}`)).status()).toBe(200);
    // Each fresh visitor's `bytes=1-` is a new transfer, so the third is refused.
    for (const context of [first, second])
      expect(
        (
          await context.request.get(url, { headers: { Range: "bytes=1-" } })
        ).status(),
      ).toBe(206);
    const third = await visitor();
    try {
      const refused = await third.request.get(url, {
        headers: { Range: "bytes=1-" },
      });
      expect(refused.status()).toBe(404);
    } finally {
      await third.close();
    }
    // The visitors who were counted can still resume their own transfers.
    expect(
      (
        await first.request.get(url, { headers: { Range: "bytes=3-" } })
      ).status(),
    ).toBe(206);
  } finally {
    await first.close();
    await second.close();
  }
});

test("a LOCK refused by the per-user lock limit leaves no empty file behind", async ({
  context,
  request,
}) => {
  const headers = await davHeaders(context);
  const folder = await davFolder(request, headers);
  const lockBody = `<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>`;
  const lock = (name: string) =>
    request.fetch(`/dav/${folder}/${name}`, {
      method: "LOCK",
      headers: {
        ...headers,
        Depth: "0",
        Timeout: "Second-300",
        "Content-Type": "application/xml",
      },
      data: lockBody,
    });
  const tokens: [string, string][] = [];
  try {
    for (let batch = 0; batch < 1000; batch += 50) {
      const granted = await Promise.all(
        Array.from({ length: 50 }, async (_, offset) => {
          const name = `l${batch + offset}`;
          const response = await lock(name);
          expect(response.status()).toBe(201);
          return [name, response.headers()["lock-token"] ?? ""] as [
            string,
            string,
          ];
        }),
      );
      tokens.push(...granted);
    }
    expect((await lock("extra")).status()).toBe(429);
    expect(
      (await request.get(`/dav/${folder}/extra`, { headers })).status(),
    ).toBe(404);
  } finally {
    for (let index = 0; index < tokens.length; index += 50)
      await Promise.all(
        tokens.slice(index, index + 50).map(([name, token]) =>
          request.fetch(`/dav/${folder}/${name}`, {
            method: "UNLOCK",
            headers: { ...headers, "Lock-Token": token },
          }),
        ),
      );
  }
});

test("WebDAV GET and HEAD do not reveal whether a path the user cannot read exists", async ({
  context,
  request,
  browser,
}) => {
  const email = `bytes-${randomUUID()}@nimbus.test`;
  const created = await context.request.post("/api/auth/admin/create-user", {
    headers: { Origin: origin },
    data: { name: "Robin Vale", email, password, role: "user" },
  });
  expect(created.ok()).toBe(true);
  const secret = `secret-${randomUUID()}.txt`;
  expect(
    (
      await request.put(`/dav/homes/admin/${secret}`, {
        headers: await davHeaders(context),
        data: "private",
      })
    ).status(),
  ).toBe(201);
  const member = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    await login(await member.newPage(), email);
    const { token } = await (
      await client(member)
    ).appPasswords.create.mutate({
      name: `Bytes ${randomUUID()}`,
    });
    const headers = {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
    };
    for (const method of ["GET", "HEAD"])
      for (const name of [secret, `missing-${randomUUID()}.txt`])
        expect(
          (
            await member.request.fetch(`/dav/homes/admin/${name}`, {
              method,
              headers,
            })
          ).status(),
          `${method} ${name}`,
        ).toBe(403);
  } finally {
    await member.close();
  }
});

test("folder archives are only built for requests from Nimbus itself", async ({
  context,
}) => {
  const post = async (headers: Record<string, string>) => {
    const response = await context.request.post("/api/files/archive", {
      headers,
      form: { path: "docs" },
    });
    await response.dispose();
    return response.status();
  };
  expect(await post({ "Sec-Fetch-Site": "same-origin", Origin: origin })).toBe(
    200,
  );
  expect(await post({})).toBe(200);
  // Nimbus pages send no referrer, so the browser's own form POST says Origin: null.
  expect(await post({ "Sec-Fetch-Site": "same-origin", Origin: "null" })).toBe(
    200,
  );
  expect(await post({ "Sec-Fetch-Site": "cross-site", Origin: "null" })).toBe(
    403,
  );
  // A sibling subdomain is same-site, so the browser still sends the Lax session cookie.
  expect(
    await post({
      "Sec-Fetch-Site": "same-site",
      Origin: "https://evil.localhost",
    }),
  ).toBe(403);
  expect(await post({ "Sec-Fetch-Site": "cross-site" })).toBe(403);
  // Browsers without fetch metadata still send Origin on a form POST.
  expect(await post({ Origin: "https://evil.example" })).toBe(403);
});
