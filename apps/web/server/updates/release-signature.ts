import { generateKeyPairSync } from "node:crypto";
import { z } from "zod";

/**
 * Ed25519 signatures of release manifests (see docs/updates.md). The image carries the public
 * keys it trusts (its trust root, `apps/web/release-keys.json`); a manifest is accepted only with
 * a signature by one of them, named by key id. CI holds the private key.
 */
export type TrustRoot = { keys: Map<string, CryptoKey> };

export type SignatureError =
  | { kind: "invalid-trust-root"; message: string }
  | { kind: "invalid-signature"; message: string }
  | { kind: "untrusted-key"; message: string }
  | { kind: "bad-signature"; message: string };

/** `manifest.sig`: which key signed, and the signature of the manifest's exact bytes. */
const signatureFile = z.object({
  keyId: z.string().regex(/^[\w.-]{1,64}$/),
  signature: z.base64(),
});
const trustFile = z.object({
  keys: z
    .array(
      z.object({
        id: z.string().regex(/^[\w.-]{1,64}$/),
        /** The raw 32-byte Ed25519 public key, base64. */
        publicKey: z.base64(),
      }),
    )
    .max(16),
});

const MAX_SIGNATURE_BYTES = 4096;
const decoder = new TextDecoder("utf-8", { fatal: true });

function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
}

export const ReleaseSignature = {
  /** The trust root from the bytes of `release-keys.json`. */
  async trustRoot(
    bytes: Uint8Array,
  ): Promise<
    { ok: true; value: TrustRoot } | { ok: false; error: SignatureError }
  > {
    const parsed = trustFile.safeParse(json(bytes));
    if (!parsed.success)
      return {
        ok: false,
        error: {
          kind: "invalid-trust-root",
          message:
            "The image's release-keys.json does not list release keys as { keys: [{ id, publicKey }] }, so no update can be verified. Rebuild the image with a valid file.",
        },
      };
    const keys = new Map<string, CryptoKey>();
    for (const key of parsed.data.keys) {
      const raw = Buffer.from(key.publicKey, "base64");
      if (raw.byteLength !== 32)
        return {
          ok: false,
          error: {
            kind: "invalid-trust-root",
            message: `Release key ${key.id} in the image's release-keys.json is ${raw.byteLength} bytes, not the 32 of an Ed25519 public key, so no update can be verified. Rebuild the image with a valid file.`,
          },
        };
      keys.set(
        key.id,
        await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, [
          "verify",
        ]),
      );
    }
    return { ok: true, value: { keys } };
  },

  /** Whether `signature` (the bytes of `manifest.sig`) signs exactly `manifest` by a trusted key. */
  async verify(
    trust: TrustRoot,
    manifest: Uint8Array<ArrayBuffer>,
    signature: Uint8Array,
  ): Promise<
    { ok: true; keyId: string } | { ok: false; error: SignatureError }
  > {
    const parsed =
      signature.byteLength <= MAX_SIGNATURE_BYTES
        ? signatureFile.safeParse(json(signature))
        : null;
    if (!parsed?.success)
      return {
        ok: false,
        error: {
          kind: "invalid-signature",
          message:
            "The release's manifest.sig is not a signature file ({ keyId, signature }), so the release was not trusted.",
        },
      };
    const key = trust.keys.get(parsed.data.keyId);
    if (!key)
      return {
        ok: false,
        error: {
          kind: "untrusted-key",
          message: `The release is signed with key ${parsed.data.keyId}, which this image does not trust${trust.keys.size ? ` (it trusts ${[...trust.keys.keys()].join(", ")})` : " (it trusts no release key)"}, so it was not installed. Use an image that trusts that key, or an update source that publishes releases signed for this one.`,
        },
      };
    const valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      Buffer.from(parsed.data.signature, "base64"),
      manifest,
    );
    return valid
      ? { ok: true, keyId: parsed.data.keyId }
      : {
          ok: false,
          error: {
            kind: "bad-signature",
            message: `The release's signature by key ${parsed.data.keyId} does not match its manifest: it was changed after signing or signed with another key. Nothing was installed.`,
          },
        };
  },

  /** `manifest.sig` for `manifest`, signed with a PKCS #8 Ed25519 private key. For CI and tests. */
  async sign(
    privateKey: Uint8Array<ArrayBuffer>,
    keyId: string,
    manifest: Uint8Array<ArrayBuffer>,
  ) {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      privateKey,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("Ed25519", key, manifest);
    return new TextEncoder().encode(
      `${JSON.stringify({ keyId, signature: Buffer.from(signature).toString("base64") })}\n`,
    );
  },

  /** A new key pair: the trust-root entry and the private key CI signs with. */
  async generate(keyId: string) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    // An Ed25519 SPKI is a fixed 12-byte prefix and the 32-byte raw key.
    const spki = publicKey.export({ format: "der", type: "spki" });
    return {
      trustEntry: {
        id: keyId,
        publicKey: spki.subarray(spki.byteLength - 32).toString("base64"),
      },
      privateKey: new Uint8Array(
        privateKey.export({ format: "der", type: "pkcs8" }),
      ),
    };
  },
} as const;
