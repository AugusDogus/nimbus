import { describe, expect, it } from "bun:test";
import {
  DOWNLOAD_LINK_TTL_MS,
  signDownloadLink,
  verifyDownloadLink,
} from "./download-link";
import { LinkSeal } from "./link-seal";

const secret = "s".repeat(32);
const link = { userId: "user-1", grantId: "grant-1", path: "docs/report.pdf" };

describe("download links", () => {
  it("round-trips a path for a connection until it expires", () => {
    const { token, expiresAt } = signDownloadLink(secret, link, 1000);
    expect(expiresAt).toBe(1000 + DOWNLOAD_LINK_TTL_MS);
    expect(verifyDownloadLink(secret, token, 2000)).toEqual({
      kind: "valid",
      ...link,
    });
    expect(verifyDownloadLink(secret, token, expiresAt)).toEqual({
      kind: "expired",
    });
  });
  it("does not show the path it names", () => {
    const { token } = signDownloadLink(secret, link, 1000);
    expect(Buffer.from(token, "base64url").toString("latin1")).not.toContain(
      "report",
    );
  });
  it("rejects tampered tokens, other servers' links and upload tokens", () => {
    const { token } = signDownloadLink(secret, link, 1000);
    const bytes = Buffer.from(token, "base64url");
    bytes[20] = (bytes[20] ?? 0) ^ 1;
    expect(
      verifyDownloadLink(secret, bytes.toString("base64url"), 2000),
    ).toEqual({ kind: "invalid" });
    expect(verifyDownloadLink("t".repeat(32), token, 2000)).toEqual({
      kind: "invalid",
    });
    expect(verifyDownloadLink(secret, "garbage", 2000)).toEqual({
      kind: "invalid",
    });
    const upload = LinkSeal.seal(secret, "upload", {
      v: 2,
      u: "user-1",
      g: "grant-1",
      p: "private.txt",
      e: 9e15,
    });
    expect(verifyDownloadLink(secret, upload, 2000)).toEqual({
      kind: "invalid",
    });
  });
});
