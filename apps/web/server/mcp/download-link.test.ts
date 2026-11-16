import { describe, expect, it } from "bun:test";
import {
  DOWNLOAD_LINK_TTL_MS,
  signDownloadLink,
  verifyDownloadLink,
} from "./download-link";

const secret = "s".repeat(32);

describe("download links", () => {
  it("round-trips a path for a connection until it expires", () => {
    const { token, expiresAt } = signDownloadLink(
      secret,
      "grant-1",
      "docs/report.pdf",
      1000,
    );
    expect(expiresAt).toBe(1000 + DOWNLOAD_LINK_TTL_MS);
    expect(verifyDownloadLink(secret, token, 2000)).toEqual({
      kind: "valid",
      grantId: "grant-1",
      path: "docs/report.pdf",
    });
    expect(verifyDownloadLink(secret, token, expiresAt)).toEqual({
      kind: "expired",
    });
  });
  it("rejects tampered paths and other servers' links", () => {
    const { token } = signDownloadLink(
      secret,
      "grant-1",
      "docs/report.pdf",
      1000,
    );
    const [, signature] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ v: 1, g: "grant-1", p: "private.txt", e: 9e15 })).toString("base64url")}.${signature}`;
    expect(verifyDownloadLink(secret, forged, 2000)).toEqual({
      kind: "invalid",
    });
    expect(verifyDownloadLink("t".repeat(32), token, 2000)).toEqual({
      kind: "invalid",
    });
    expect(verifyDownloadLink(secret, "garbage", 2000)).toEqual({
      kind: "invalid",
    });
  });
});
