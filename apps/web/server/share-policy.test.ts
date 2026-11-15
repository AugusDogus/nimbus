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
  expect(
    SharePolicy.availability({ ...share, expiresAt: 1000 }, 1000),
  ).toEqual({ kind: "expired" });
  expect(
    SharePolicy.availability({ ...share, maxDownloads: 2, downloadCount: 1 }, 0),
  ).toEqual({ kind: "available" });
  expect(
    SharePolicy.availability({ ...share, maxDownloads: 2, downloadCount: 2 }, 0),
  ).toEqual({ kind: "exhausted" });
});

const response = (status: number, headers: HeadersInit = {}) =>
  new Response(null, { status, headers });

test("only transfers that include the first byte count as downloads", () => {
  expect(SharePolicy.countsAsTransfer("GET", response(200))).toBe(true);
  expect(
    SharePolicy.countsAsTransfer(
      "GET",
      response(206, { "Content-Range": "bytes 0-99/1000" }),
    ),
  ).toBe(true);
  // Resumed downloads and media seeking continue an already counted transfer.
  expect(
    SharePolicy.countsAsTransfer(
      "GET",
      response(206, { "Content-Range": "bytes 100-999/1000" }),
    ),
  ).toBe(false);
  expect(SharePolicy.countsAsTransfer("HEAD", response(200))).toBe(false);
  expect(SharePolicy.countsAsTransfer("GET", response(404))).toBe(false);
  expect(SharePolicy.countsAsTransfer("GET", response(416))).toBe(false);
});

test("view-only links serve inline previews and refuse attachments", () => {
  const inline = response(200, { "Content-Disposition": "inline; filename*=UTF-8''a.png" });
  const attachment = response(200, { "Content-Disposition": "attachment; filename*=UTF-8''a.zip" });
  expect(SharePolicy.permitsResponse("view", inline)).toBe(true);
  expect(SharePolicy.permitsResponse("view", attachment)).toBe(false);
  expect(SharePolicy.permitsResponse("download", attachment)).toBe(true);
});
