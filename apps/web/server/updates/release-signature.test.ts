import { expect, test } from "bun:test";
import { ReleaseManifest } from "./release-manifest";
import { ReleaseSignature, type TrustRoot } from "./release-signature";
import { testManifest } from "./updates-testing";

async function signer(id = "release-1") {
  const { trustEntry, privateKey } = await ReleaseSignature.generate(id);
  const trust = await ReleaseSignature.trustRoot(
    new TextEncoder().encode(JSON.stringify({ keys: [trustEntry] })),
  );
  if (!trust.ok) throw new Error(trust.error.message);
  return { trust: trust.value, privateKey, id };
}

const bytes = ReleaseManifest.encode(testManifest(7));

test("a manifest signed by a trusted key verifies", async () => {
  const { trust, privateKey, id } = await signer();
  const signature = await ReleaseSignature.sign(privateKey, id, bytes);
  expect(await ReleaseSignature.verify(trust, bytes, signature)).toEqual({
    ok: true,
    keyId: id,
  });
});

test("a manifest changed after signing is refused", async () => {
  const { trust, privateKey, id } = await signer();
  const signature = await ReleaseSignature.sign(privateKey, id, bytes);
  const changed = bytes.slice();
  changed[changed.length - 3] ^= 1;
  const verified = await ReleaseSignature.verify(trust, changed, signature);
  expect(verified.ok).toBe(false);
  if (!verified.ok) expect(verified.error.kind).toBe("bad-signature");
});

test("a signature by an untrusted key, or a key claiming a trusted id, is refused", async () => {
  const { trust } = await signer("release-1");
  const other = await signer("release-2");
  const byOther = await ReleaseSignature.sign(
    other.privateKey,
    "release-2",
    bytes,
  );
  const untrusted = await ReleaseSignature.verify(trust, bytes, byOther);
  expect(untrusted.ok || untrusted.error.kind).toBe("untrusted-key");
  // The other key's signature, presented as if by the trusted key's id.
  const impostor = await ReleaseSignature.sign(
    other.privateKey,
    "release-1",
    bytes,
  );
  const forged = await ReleaseSignature.verify(trust, bytes, impostor);
  expect(forged.ok || forged.error.kind).toBe("bad-signature");
});

test("an image that trusts no key verifies nothing, and says so", async () => {
  const empty = await ReleaseSignature.trustRoot(
    new TextEncoder().encode('{"keys":[]}'),
  );
  if (!empty.ok) throw new Error(empty.error.message);
  const { privateKey, id } = await signer();
  const verified = await ReleaseSignature.verify(
    empty.value satisfies TrustRoot,
    bytes,
    await ReleaseSignature.sign(privateKey, id, bytes),
  );
  expect(verified.ok).toBe(false);
  if (!verified.ok)
    expect(verified.error.message).toContain("trusts no release key");
});

test("a malformed signature file or trust root is refused", async () => {
  const { trust } = await signer();
  const garbage = await ReleaseSignature.verify(
    trust,
    bytes,
    new TextEncoder().encode("not json"),
  );
  expect(garbage.ok || garbage.error.kind).toBe("invalid-signature");
  const short = await ReleaseSignature.trustRoot(
    new TextEncoder().encode('{"keys":[{"id":"k","publicKey":"AAAA"}]}'),
  );
  expect(short.ok).toBe(false);
});
