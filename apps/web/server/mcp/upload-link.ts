import { createHash, randomBytes } from "node:crypto";
import { UploadDestination } from "@nimbus/api/upload-destination";
import { z } from "zod";
import { LinkSeal } from "./link-seal";

/**
 * Long enough to start a folder's worth of uploads after asking for the link, short enough
 * that a leaked URL soon stops working. An upload that started in time may finish later.
 */
export const UPLOAD_LINK_TTL_MS = 15 * 60 * 1000;

const claimsSchema = z.object({
  v: z.literal(2),
  u: z.string().min(1),
  g: z.string().min(1),
  /** The scope the link was made with. Only files:write makes upload links. */
  s: z.literal("files:write"),
  d: UploadDestination.schema,
  /** Random: names this link among others for the same destination. */
  n: z.string().min(16),
  e: z.number().int(),
});

export type UploadLink = {
  userId: string;
  grantId: string;
  destination: UploadDestination;
  nonce: string;
  expiresAt: number;
};

export type UploadLinkCheck =
  | { kind: "valid"; link: UploadLink }
  | { kind: "invalid" }
  | { kind: "expired" };

/**
 * A sealed reference to one upload destination for one account's MCP connection, made with
 * files:write. It carries no access by itself: the upload route re-checks the connection, the
 * account and its write permission when the upload starts and again at commit.
 */
function sign(
  secret: string,
  link: { userId: string; grantId: string; destination: UploadDestination },
  now: number,
) {
  const expiresAt = now + UPLOAD_LINK_TTL_MS;
  return {
    token: LinkSeal.seal(secret, "upload", {
      v: 2,
      u: link.userId,
      g: link.grantId,
      s: "files:write",
      d: link.destination,
      n: randomBytes(16).toString("base64url"),
      e: expiresAt,
    }),
    expiresAt,
  };
}

/** Whether `token` may start an upload at `now`. Uploads already running are not re-checked here. */
function verify(secret: string, token: string, now: number): UploadLinkCheck {
  const claims = claimsSchema.safeParse(LinkSeal.open(secret, "upload", token));
  if (!claims.success) return { kind: "invalid" };
  if (claims.data.e <= now) return { kind: "expired" };
  return {
    kind: "valid",
    link: {
      userId: claims.data.u,
      grantId: claims.data.g,
      destination: claims.data.d,
      nonce: claims.data.n,
      expiresAt: claims.data.e,
    },
  };
}

/**
 * The record of one committed path of one link, stored as a token hash so each path commits
 * once. `relative` is the path below a folder link's folder, or "" for a file link.
 */
const commitKey = (link: Pick<UploadLink, "nonce">, relative: string) =>
  createHash("sha256")
    .update(`upload\0${link.nonce}\0${relative}`, "utf8")
    .digest("base64url");

export const UploadLink = { sign, verify, commitKey } as const;
