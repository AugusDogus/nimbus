/**
 * The installer process: installs one release for the supervisor (see installRelease), so the
 * download and the unpacking never run in the supervisor itself. It reads one JSON request on
 * standard input and writes one JSON line with the outcome. It trusts only the image's keys,
 * whatever the request says.
 */
import path from "node:path";
import { z } from "zod";
import { installRelease } from "../updates/release-installer";
import { TrustRoot } from "../updates/trust-root";
import { UpdateSource } from "../updates/update-source";
import { PROTOCOL_VERSION } from "./protocol";

const request = z.object({
  releases: z.string().startsWith("/"),
  source: z.string(),
  manifest: z.base64(),
  signature: z.base64(),
});

const answer = (
  outcome: { ok: true; name: string } | { ok: false; message: string },
) => {
  console.info(JSON.stringify(outcome));
  process.exit(outcome.ok ? 0 : 1);
};

let input: unknown;
try {
  input = JSON.parse(await Bun.stdin.text());
} catch {
  input = null;
}
const parsed = request.safeParse(input);
if (!parsed.success)
  answer({ ok: false, message: "The installer got no valid request." });
else {
  const builtInRoot = path.resolve(import.meta.dir, "../../../..");
  const trust = await TrustRoot.load(builtInRoot);
  if (!trust.ok) answer({ ok: false, message: trust.message });
  else {
    const source = UpdateSource.fromEnvironment(parsed.data.source, null);
    if (!source.ok || source.value.kind !== "url")
      answer({
        ok: false,
        message: "The installer got no update source to fetch from.",
      });
    else {
      const installed = await installRelease({
        releases: parsed.data.releases,
        source: source.value,
        manifest: new Uint8Array(Buffer.from(parsed.data.manifest, "base64")),
        signature: new Uint8Array(Buffer.from(parsed.data.signature, "base64")),
        trust: trust.value,
        builtInRoot,
        supervisorProtocol: PROTOCOL_VERSION,
      });
      answer(
        installed.ok
          ? installed
          : { ok: false, message: installed.error.message },
      );
    }
  }
}
