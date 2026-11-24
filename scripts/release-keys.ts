/**
 * Makes a release signing key (see docs/updates.md):
 *
 *   bun scripts/release-keys.ts <key id>
 *
 * Prints the entry to add to apps/web/release-keys.json, which every image built afterwards
 * trusts, and the private key to store as the NIMBUS_RELEASE_SIGNING_KEY secret of the
 * `release-signing` environment, which only the publishing job may use. The private key is
 * printed once and kept nowhere; whoever has it can publish updates every such image installs.
 */
import { ReleaseSignature } from "../apps/web/server/updates/release-signature";

const keyId = process.argv[2];
if (!keyId || !/^[\w.-]{1,64}$/.test(keyId)) {
  console.error(
    "Usage: bun scripts/release-keys.ts <key id, such as release-2026>",
  );
  process.exit(2);
}
const { trustEntry, privateKey } = await ReleaseSignature.generate(keyId);
console.info(
  `Add to apps/web/release-keys.json "keys":\n${JSON.stringify(trustEntry)}\n`,
);
console.info(
  `Store as the NIMBUS_RELEASE_SIGNING_KEY secret, then forget it:\n${Buffer.from(privateKey).toString("base64")}`,
);
