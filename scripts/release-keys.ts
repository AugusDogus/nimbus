/**
 * Makes a release signing key (see docs/updates.md):
 *
 *   bun scripts/release-keys.ts <key id> --private-key-file <path>
 *   bun scripts/release-keys.ts <key id> --private-key-stdout
 *
 * Prints the entry to add to apps/web/release-keys.json, which every image built afterwards
 * trusts. The private key, to store as the NIMBUS_RELEASE_SIGNING_KEY secret of the
 * `release-signing` environment, goes only where asked: a new file only its owner may read
 * (mode 600; an existing file is never overwritten), or standard output alone, with the public
 * entry on standard error, for piping it straight into a secret store. Whoever has it can
 * publish updates every image that trusts it installs.
 */
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ReleaseSignature } from "../apps/web/server/updates/release-signature";

const usage =
  "Usage: bun scripts/release-keys.ts <key id, such as release-2026> (--private-key-file <path> | --private-key-stdout)";
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "private-key-file": { type: "string" },
    "private-key-stdout": { type: "boolean", default: false },
  },
});
const keyId = positionals[0];
const file = args["private-key-file"];
const toStdout = args["private-key-stdout"];
if (
  !keyId ||
  !/^[\w.-]{1,64}$/.test(keyId) ||
  (file === undefined) === !toStdout
) {
  console.error(usage);
  process.exit(2);
}

const { trustEntry, privateKey } = await ReleaseSignature.generate(keyId);
const encoded = Buffer.from(privateKey).toString("base64");
const entry = `Add to apps/web/release-keys.json "keys":\n${JSON.stringify(trustEntry)}`;
if (file !== undefined) {
  let handle;
  try {
    // Created only if absent, readable by its owner alone, before a byte is written.
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    console.error(
      `No key was made: ${file} could not be created (${error instanceof Error ? error.message : String(error)}). Name a new file in a folder only you can read.`,
    );
    process.exit(1);
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${encoded}\n`);
  } finally {
    await handle.close();
  }
  console.info(
    `${entry}\n\nThe private key is in ${file} (mode 600). Store it as the NIMBUS_RELEASE_SIGNING_KEY secret, then delete the file.`,
  );
} else {
  console.error(entry);
  process.stdout.write(`${encoded}\n`);
}
