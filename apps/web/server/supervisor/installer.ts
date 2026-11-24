/**
 * The installer process (see docs/updates.md): the only process that touches the network for an
 * update and a bundle's bytes. The supervisor runs it as the update user, with no capabilities,
 * an allowlisted environment, the staging folder as its home and working folder, and pipes only.
 * It reads one JSON request on standard input and writes one JSON line with the outcome, which
 * the supervisor treats as data: what it staged is copied and checked again by root before
 * anything of it can run. It trusts only the image's keys, whatever the request says.
 *
 * - `stage`: download the bundle the signed manifest names into `<staging>/release`.
 * - `clean`: remove what an earlier `stage` left.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { stageRelease } from "../updates/release-installer";
import { TrustRoot } from "../updates/trust-root";
import { UpdateSource } from "../updates/update-source";
import { PROTOCOL_VERSION } from "./protocol";
import { TestSeams } from "./test-seams";

const request = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stage"),
    staging: z.string().startsWith("/"),
    source: z.string(),
    manifest: z.base64(),
    signature: z.base64(),
  }),
  z.object({ kind: z.literal("clean"), staging: z.string().startsWith("/") }),
]);

function answer(
  outcome: { ok: true; name: string } | { ok: false; message: string },
): never {
  console.info(JSON.stringify(outcome));
  process.exit(outcome.ok ? 0 : 1);
}

let input: unknown;
try {
  input = JSON.parse(await Bun.stdin.text());
} catch {
  input = null;
}
const parsed = request.safeParse(input);
if (!parsed.success)
  answer({ ok: false, message: "The installer got no valid request." });
const asked = parsed.data;
if (asked.kind === "clean") {
  await rm(path.join(asked.staging, "release"), {
    recursive: true,
    force: true,
  });
  answer({ ok: true, name: "" });
}
const builtInRoot = path.resolve(import.meta.dir, "../../../..");
const trust = await TrustRoot.load(
  builtInRoot,
  TestSeams.fromEnvironment(process.env, builtInRoot).keysFile,
);
if (!trust.ok) answer({ ok: false, message: trust.message });
const source = UpdateSource.fromEnvironment(asked.source, null);
if (!source.ok || source.value.kind !== "url")
  answer({
    ok: false,
    message: "The installer got no update source to fetch from.",
  });
const staged = await stageRelease({
  staging: asked.staging,
  source: source.value,
  manifest: new Uint8Array(Buffer.from(asked.manifest, "base64")),
  signature: new Uint8Array(Buffer.from(asked.signature, "base64")),
  trust: trust.value,
  builtInRoot,
  supervisorProtocol: PROTOCOL_VERSION,
});
answer(staged.ok ? staged : { ok: false, message: staged.error.message });
