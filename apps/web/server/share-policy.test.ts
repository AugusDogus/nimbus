import { expect, setSystemTime, test } from "bun:test";
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

/** The cookie a browser holds after `responses` set theirs, as `name=value` pairs. */
const jar = (current: string, ...responses: Response[]) => {
  const cookies = new Map(
    current
      .split("; ")
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair] as const),
  );
  for (const served of responses)
    for (const header of served.headers.getSetCookie()) {
      const pair = header.split(";")[0] ?? "";
      const name = pair.slice(0, pair.indexOf("="));
      if (/Max-Age=0/.test(header)) cookies.delete(name);
      else cookies.set(name, pair);
    }
  return [...cookies.values()].join("; ");
};

/**
 * The policy's calls with each response's file version taken from its ETag header, so these
 * tests can name versions as the responses' tags.
 */
const countsAsTransfer = (
  request: Request,
  served: Response,
  link: Pick<Share, "token">,
  relative: string,
) =>
  SharePolicy.countsAsTransfer(
    request,
    served,
    link,
    relative,
    served.headers.get("etag"),
  );
const allowContinuation = (
  request: Request,
  served: Response,
  link: Pick<Share, "token">,
  relative: string,
) =>
  SharePolicy.allowContinuation(
    request,
    served,
    link,
    relative,
    served.headers.get("etag"),
  );

test("ranges count unless they continue a transfer this browser already made", () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
  const counts = (request: Request, served: Response) =>
    countsAsTransfer(request, served, share, "docs/a.txt");
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
  allowContinuation(get(), counted, share, "docs/a.txt");
  const cookie = counted.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).toStartWith("nimbus-transfer-");
  expect(counts(get({ cookie }), range(100))).toBe(false);
  expect(counts(get({ cookie }), range(0))).toBe(false);
  // Never another full copy, another file, or a changed file.
  expect(counts(get({ cookie }), response(200))).toBe(true);
  expect(
    countsAsTransfer(get({ cookie }), range(100), share, "docs/b.txt"),
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
    allowContinuation(get({ cookie }), counted, share, name);
    cookie = jar(cookie, counted);
  }
  for (const [name, etag] of [
    ["docs/a.txt", '"a"'],
    ["docs/b.txt", '"b"'],
  ] as const)
    expect(countsAsTransfer(get({ cookie }), range(etag), share, name)).toBe(
      false,
    );
});

test("transfers started at the same time stay continuable", () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
  const range = (etag: string) =>
    response(206, { "Content-Range": "bytes 100-999/1000", ETag: etag });
  // Both requests carry the cookie from before either transfer.
  const a = response(200, { ETag: '"a"' });
  const b = response(200, { ETag: '"b"' });
  allowContinuation(get(), a, share, "docs/a.txt");
  allowContinuation(get(), b, share, "docs/b.txt");
  const cookie = jar("", a, b);
  expect(
    countsAsTransfer(get({ cookie }), range('"a"'), share, "docs/a.txt"),
  ).toBe(false);
  expect(
    countsAsTransfer(get({ cookie }), range('"b"'), share, "docs/b.txt"),
  ).toBe(false);
});

test("a browser keeps at most 16 transfers continuable, dropping the oldest", () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
  let cookie = "";
  for (let index = 0; index < 20; index++) {
    const counted = response(200, { ETag: `"${index}"` });
    allowContinuation(get({ cookie }), counted, share, `docs/${index}.txt`);
    cookie = jar(cookie, counted);
  }
  expect(cookie.split("; ")).toHaveLength(16);
  const continues = (index: number) =>
    !countsAsTransfer(
      get({ cookie }),
      response(206, { "Content-Range": "bytes 1-9/10", ETag: `"${index}"` }),
      share,
      `docs/${index}.txt`,
    );
  expect(continues(19)).toBe(true);
  expect(continues(4)).toBe(true);
  expect(continues(3)).toBe(false);
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

test("a counted PDF pages view lets the same browser take that version's whole file without counting again", () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
  const counts = (
    request: Request,
    served: Response,
    relative = "docs/a.pdf",
  ) => countsAsTransfer(request, served, share, relative);
  const whole = (etag: string) => response(200, { ETag: etag });
  const viewed = response(200);
  SharePolicy.allowPagesView(get(), viewed, share, "docs/a.pdf", '"1-1000"');
  const cookie = jar("", viewed);
  expect(cookie).toStartWith("nimbus-transfer-");
  expect(
    SharePolicy.continuesTransfer(
      get({ cookie }),
      share,
      "docs/a.pdf",
      '"1-1000"',
    ),
  ).toBe(true);
  // The whole file and its ranges continue the view: it sent no bytes of the file.
  expect(counts(get({ cookie }), whole('"1-1000"'))).toBe(false);
  expect(
    counts(
      get({ cookie }),
      response(206, { "Content-Range": "bytes 1-999/1000", ETag: '"1-1000"' }),
    ),
  ).toBe(false);
  // Bound to the browser, the file, its version and the link.
  expect(counts(get(), whole('"1-1000"'))).toBe(true);
  expect(counts(get({ cookie }), whole('"1-1000"'), "docs/b.pdf")).toBe(true);
  expect(counts(get({ cookie }), whole('"2-1000"'))).toBe(true);
  expect(
    countsAsTransfer(
      get({ cookie }),
      whole('"1-1000"'),
      { ...share, token: "other" },
      "docs/a.pdf",
    ),
  ).toBe(true);
  // A transfer proof does not stand in for it: every other whole response counts.
  const transferred = whole('"1-1000"');
  allowContinuation(get(), transferred, share, "docs/a.pdf");
  expect(counts(get({ cookie: jar("", transferred) }), whole('"1-1000"'))).toBe(
    true,
  );
});

test("only a proof that verifies for the version sent selects confirmed streaming", () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
  const body = (cookie: string, version = "1:2:3", link = share) =>
    SharePolicy.servedBody(get({ cookie }), link, "docs/a.pdf")(version);
  // Names that merely look like proofs, and a forged value under a real proof's name.
  expect(body("nimbus-transfer-garbage=bogus")).toBe("fast");
  expect(body("nimbus-transferable=bogus")).toBe("fast");
  const viewed = response(200);
  SharePolicy.allowPagesView(get(), viewed, share, "docs/a.pdf", "1:2:3");
  const cookie = jar("", viewed);
  const name = cookie.slice(0, cookie.indexOf("="));
  expect(body(`${name}=${Date.now() + 60_000}.${"0".repeat(64)}`)).toBe("fast");
  // A real proof: for this link, file and version only, until it expires.
  expect(body(cookie)).toBe("confirmed");
  expect(body(cookie, "1:2:4")).toBe("fast");
  expect(body(cookie, "1:2:3", { ...share, token: "other" })).toBe("fast");
  setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
  try {
    expect(body(cookie)).toBe("fast");
  } finally {
    setSystemTime();
  }
});
