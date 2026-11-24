/**
 * Signs a release bundle's manifest (see docs/updates.md), in CI's signing job:
 *
 *   NIMBUS_RELEASE_SIGNING_KEY=<base64 PKCS #8 Ed25519 key> \
 *     bun scripts/release-sign.ts <dir holding manifest.json and the bundle> --key-id <id> \
 *       --repository <owner/name> --channel <channel> --commit <sha> --sequence <n>
 *
 * The job holds the signing key, so it installs no package and runs no code from the bundle:
 * this script imports nothing and uses only Bun and WebCrypto. It reads manifest.json once,
 * checks that it describes the build the workflow made (the repository, channel, commit and run
 * number the workflow passes from its own context, never from the bundle) and that the bundle
 * beside it has the size and SHA-256 the manifest names, and writes manifest.sig, the signature
 * of exactly those manifest bytes.
 */
function fail(message: string): never {
  console.error(`The manifest was not signed: ${message}`);
  process.exit(1);
}

const folder = process.argv[2];
const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const keyId = option("key-id");
if (!folder || !keyId || !/^[\w.-]{1,64}$/.test(keyId))
  fail("pass the bundle folder and --key-id <id>.");
const expected = {
  repository: option("repository"),
  channel: option("channel"),
  commit: option("commit"),
  sequence: Number(option("sequence")),
};
if (
  !expected.repository ||
  !expected.channel ||
  !expected.commit ||
  !Number.isSafeInteger(expected.sequence)
)
  fail(
    "pass --repository, --channel, --commit and --sequence from the workflow's own context.",
  );
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
const build =
  typeof manifest === "object" && manifest !== null && "build" in manifest
    ? manifest.build
    : null;
const fields: Map<string, unknown> = new Map(
  typeof build === "object" && build !== null ? Object.entries(build) : [],
);
const field = (name: string) => fields.get(name);
const said = {
  repository: field("repository"),
  channel: field("channel"),
  commit: field("commit"),
  sequence: field("sequence"),
};
for (const name of ["repository", "channel", "commit", "sequence"] as const)
  if (said[name] !== expected[name])
    fail(
      `manifest.json says ${name} ${JSON.stringify(said[name])}, where this workflow built ${JSON.stringify(expected[name])}: it is not the build this workflow made.`,
    );

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
