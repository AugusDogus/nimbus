import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Opaque, tamper-proof tokens for links the MCP tools hand out. Claims are encrypted and
 * authenticated with AES-256-GCM under a key derived from the server secret for one purpose,
 * so a download token never opens as an upload token, and a URL in a proxy log or shell
 * history shows no path. A token carries no access by itself: each route re-checks the
 * connection, the account and its permissions.
 */
export type LinkPurpose = "download" | "upload";

const ivBytes = 12;
const tagBytes = 16;

const key = (secret: string, purpose: LinkPurpose) =>
  new Uint8Array(
    hkdfSync(
      "sha256",
      secret,
      new Uint8Array(0),
      `nimbus/mcp-${purpose}/v2`,
      32,
    ),
  );

function seal(secret: string, purpose: LinkPurpose, claims: unknown) {
  const iv = new Uint8Array(randomBytes(ivBytes));
  const cipher = createCipheriv("aes-256-gcm", key(secret, purpose), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(claims), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** The claims sealed in `token` for `purpose`, or null when it is malformed, forged or another purpose's. */
function open(secret: string, purpose: LinkPurpose, token: string): unknown {
  if (!/^[\w-]+$/.test(token)) return null;
  const bytes = new Uint8Array(Buffer.from(token, "base64url"));
  if (bytes.length <= ivBytes + tagBytes) return null;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(secret, purpose),
    bytes.subarray(0, ivBytes),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - tagBytes));
  try {
    const plain = Buffer.concat([
      decipher.update(bytes.subarray(ivBytes, bytes.length - tagBytes)),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plain);
  } catch {
    return null;
  }
}

export const LinkSeal = { seal, open } as const;
