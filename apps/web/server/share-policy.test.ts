import { expect, test } from "bun:test";
import type { Share } from "@nimbus/api/drive-store";
import { SharePolicy } from "./share-policy";

const share: Share = {
  id: "share",
  token: "token",
  path: "docs",
  createdBy: "owner",
  createdAt: 0,
  expiresAt: null,
  passwordHash: null,
  downloadCount: 0,
  maxDownloads: null,
  mode: "download",
};

test("links stay available until they expire or use every download", () => {
  expect(SharePolicy.availability(share, 1000)).toEqual({ kind: "available" });
  expect(SharePolicy.availability({ ...share, expiresAt: 1000 }, 1000)).toEqual(
    { kind: "expired" },
  );
  expect(
    SharePolicy.availability(
      { ...share, maxDownloads: 2, downloadCount: 1 },
      0,
    ),
  ).toEqual({ kind: "available" });
  expect(
    SharePolicy.availability(
      { ...share, maxDownloads: 2, downloadCount: 2 },
      0,
    ),
  ).toEqual({ kind: "exhausted" });
});

const response = (status: number, headers: HeadersInit = {}) =>
  new Response(null, { status, headers });

const get = (headers: HeadersInit = {}, method = "GET") =>
  new Request("http://localhost/api/share/token?download=1", {
    method,
    headers,
  });

test("ranges count unless they continue a transfer this browser already made", () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
  const counts = (request: Request, served: Response) =>
    SharePolicy.countsAsTransfer(request, served, share, "docs/a.txt");
  const range = (start: number) =>
    response(206, {
      "Content-Range": `bytes ${start}-999/1000`,
      ETag: '"1-1000"',
    });
  expect(counts(get(), response(200))).toBe(true);
  expect(counts(get(), range(0))).toBe(true);
  // A later range alone could otherwise copy all but the first byte without counting.
  expect(counts(get(), range(100))).toBe(true);
  expect(counts(get({}, "HEAD"), response(200))).toBe(false);
  expect(counts(get(), response(404))).toBe(false);
  expect(counts(get(), response(416))).toBe(false);

  // A counted transfer lets the same browser resume or seek within the same file version.
  const counted = response(200, { ETag: '"1-1000"' });
  SharePolicy.allowContinuation(get(), counted, share, "docs/a.txt");
  const cookie = counted.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).toStartWith("nimbus-transfer=");
  expect(counts(get({ cookie }), range(100))).toBe(false);
  expect(counts(get({ cookie }), range(0))).toBe(false);
  // Never another full copy, another file, or a changed file.
  expect(counts(get({ cookie }), response(200))).toBe(true);
  expect(
    SharePolicy.countsAsTransfer(
      get({ cookie }),
      range(100),
      share,
      "docs/b.txt",
    ),
  ).toBe(true);
  expect(
    counts(
      get({ cookie }),
      response(206, {
        "Content-Range": "bytes 100-999/1000",
        ETag: '"2-1000"',
      }),
    ),
  ).toBe(true);
});

test("downloading another file of the link keeps the earlier transfer continuable", () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
  const tagged = (etag: string) => response(200, { ETag: etag });
  const range = (etag: string) =>
    response(206, { "Content-Range": "bytes 100-999/1000", ETag: etag });
  let cookie = "";
  for (const [name, etag] of [
    ["docs/a.txt", '"a"'],
    ["docs/b.txt", '"b"'],
  ] as const) {
    const counted = tagged(etag);
    SharePolicy.allowContinuation(get({ cookie }), counted, share, name);
    cookie = counted.headers.get("set-cookie")?.split(";")[0] ?? "";
  }
  for (const [name, etag] of [
    ["docs/a.txt", '"a"'],
    ["docs/b.txt", '"b"'],
  ] as const)
    expect(
      SharePolicy.countsAsTransfer(get({ cookie }), range(etag), share, name),
    ).toBe(false);
});

test("view-only links serve inline previews and refuse attachments", () => {
  const inline = response(200, {
    "Content-Disposition": "inline; filename*=UTF-8''a.png",
  });
  const attachment = response(200, {
    "Content-Disposition": "attachment; filename*=UTF-8''a.zip",
  });
  expect(SharePolicy.permitsResponse("view", inline)).toBe(true);
  expect(SharePolicy.permitsResponse("view", attachment)).toBe(false);
  expect(SharePolicy.permitsResponse("download", attachment)).toBe(true);
  // Answers without content, such as a revalidated preview, carry no disposition.
  for (const status of [304, 412, 416])
    expect(SharePolicy.permitsResponse("view", response(status))).toBe(true);
  expect(SharePolicy.permitsResponse("view", response(206))).toBe(false);
});
