/**
 * Signs a release bundle's manifest (see docs/updates.md), in CI's signing job:
 *
 *   NIMBUS_RELEASE_SIGNING_KEY=<base64 PKCS #8 Ed25519 key> \
 *     bun scripts/release-sign.ts <dir holding manifest.json and the bundle> --key-id <id>
 *
 * The job holds the signing key, so it installs no package and runs no code from the bundle:
 * this script imports nothing and uses only Bun and WebCrypto. It reads manifest.json once,
 * checks that the bundle beside it has the size and SHA-256 the manifest names, and writes
 * manifest.sig, the signature of exactly those manifest bytes.
 */
function fail(message: string): never {
  console.error(`The manifest was not signed: ${message}`);
  process.exit(1);
}

const folder = process.argv[2];
const keyIndex = process.argv.indexOf("--key-id");
const keyId = keyIndex === -1 ? undefined : process.argv[keyIndex + 1];
if (!folder || !keyId || !/^[\w.-]{1,64}$/.test(keyId))
  fail("pass the bundle folder and --key-id <id>.");
const key = process.env.NIMBUS_RELEASE_SIGNING_KEY;
if (!key) fail("NIMBUS_RELEASE_SIGNING_KEY is not set.");

const bytes = new Uint8Array(
  await Bun.file(`${folder}/manifest.json`).arrayBuffer(),
);
let manifest: unknown;
try {
  manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
} catch {
  fail("manifest.json is not JSON.");
}
const bundle =
  typeof manifest === "object" && manifest !== null && "bundle" in manifest
    ? manifest.bundle
    : null;
const file =
  typeof bundle === "object" && bundle !== null && "file" in bundle
    ? bundle.file
    : null;
const size =
  typeof bundle === "object" && bundle !== null && "size" in bundle
    ? bundle.size
    : null;
const sha256 =
  typeof bundle === "object" && bundle !== null && "sha256" in bundle
    ? bundle.sha256
    : null;
if (
  typeof file !== "string" ||
  !/^[\w.-]{1,200}\.tar\.gz$/.test(file) ||
  typeof size !== "number" ||
  typeof sha256 !== "string"
)
  fail("manifest.json names no bundle file, size and SHA-256.");

const hasher = new Bun.CryptoHasher("sha256");
let read = 0;
for await (const chunk of Bun.file(`${folder}/${file}`).stream()) {
  hasher.update(chunk);
  read += chunk.byteLength;
}
const actual = hasher.digest("hex");
if (read !== size || actual !== sha256)
  fail(
    `${file} is ${read} bytes with SHA-256 ${actual}, not the bundle the manifest names (${size} bytes, ${sha256}).`,
  );

const signing = await crypto.subtle
  .importKey(
    "pkcs8",
    new Uint8Array(Buffer.from(key, "base64")),
    { name: "Ed25519" },
    false,
    ["sign"],
  )
  .catch(() => null);
if (!signing)
  fail(
    "NIMBUS_RELEASE_SIGNING_KEY is not a base64 PKCS #8 Ed25519 private key.",
  );
const signature = await crypto.subtle.sign("Ed25519", signing, bytes);
await Bun.write(
  `${folder}/manifest.sig`,
  `${JSON.stringify({ keyId, signature: Buffer.from(signature).toString("base64") })}\n`,
);
console.info(`Signed manifest.json for ${file} with key ${keyId}.`);

// A module, for top-level await, that still imports nothing.
export {};
