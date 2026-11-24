import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { BuildInfo } from "../updates/build-info";
import {
  ReleaseManifest,
  type ReleaseManifest as Manifest,
} from "../updates/release-manifest";

/** Shared by the real-process update tests: a release built and signed as CI does it. */
export const web = path.resolve(import.meta.dir, "../..");
export const repo = path.resolve(web, "../..");

/** Mark this checkout, the built-in release, as build `sequence` of example/nimbus on edge. */
export async function writeBuiltInInfo(sequence: number) {
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
    .stdout.toString()
    .trim();
  await Bun.write(
    BuildInfo.file(web),
    BuildInfo.encode({
      repository: "example/nimbus",
      commit,
      sequence,
      channel: "edge",
      image: "ghcr.io/example/nimbus:edge",
    }),
  );
}

/**
 * Build `sequence` by the real bundle builder into `<root>/out-<sequence>`, signed by the script
 * CI's signing job runs, with `privateKey` as key `test-key`. About a minute.
 */
export async function buildSignedRelease(
  root: string,
  sequence: number,
  privateKey: Uint8Array<ArrayBuffer>,
): Promise<{ manifest: Manifest; archive: string }> {
  const out = path.join(root, `out-${sequence}`);
  const builder = Bun.spawnSync(
    [
      process.execPath,
      "scripts/release-bundle.ts",
      "--out",
      out,
      "--sequence",
      String(sequence),
      "--repository",
      "example/nimbus",
      "--image",
      "ghcr.io/example/nimbus:edge",
    ],
    { cwd: repo, env: { ...process.env, TMPDIR: root } },
  );
  if (builder.exitCode !== 0) throw new Error(builder.stderr.toString());
  const signer = Bun.spawnSync(
    [
      process.execPath,
      "scripts/release-sign.ts",
      out,
      "--key-id",
      "test-key",
      "--repository",
      "example/nimbus",
      "--channel",
      "edge",
      "--commit",
      Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
        .stdout.toString()
        .trim(),
      "--sequence",
      String(sequence),
    ],
    {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? "",
        NIMBUS_RELEASE_SIGNING_KEY: Buffer.from(privateKey).toString("base64"),
      },
    },
  );
  if (signer.exitCode !== 0) throw new Error(signer.stderr.toString());
  const manifest = ReleaseManifest.parse(
    new Uint8Array(
      await Bun.file(path.join(out, "manifest.json")).arrayBuffer(),
    ),
  );
  if (!manifest.ok) throw new Error(manifest.error.message);
  return {
    manifest: manifest.value,
    archive: path.join(out, manifest.value.bundle.file),
  };
}

/**
 * Processes of this user a test started for `root`: each carries the test folder in its
 * environment (NIMBUS_CONFIG_ROOT and the like), wherever it works.
 */
async function processesUnder(root: string) {
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const environ = await readFile(`/proc/${name}/environ`, "utf8").catch(
      () => "",
    );
    if (environ.split("\0").some((entry) => entry.includes(`=${root}/`)))
      found.push(Number(name));
  }
  return found;
}

/**
 * Stop a test's supervisor promptly and leave nothing behind (the real-process tests' teardown):
 * SIGTERM, so it drains its servers within the short NIMBUS_STOP_SECONDS the tests set, then
 * SIGKILL if it outlives `stopMs`; then every process still working under `root` is killed and
 * looked for again, and `root` removed. Each step's time goes to `log`, so a slow one is named.
 */
export async function tearDown({
  supervisor,
  root,
  stopMs = 15_000,
  log = (line: string) => console.info(line),
}: {
  supervisor: {
    exitCode: number | null;
    kill(signal?: number | NodeJS.Signals): void;
    exited: Promise<number>;
  } | null;
  root: string | undefined;
  stopMs?: number;
  log?: (line: string) => void;
}) {
  const step = async (what: string, run: () => Promise<unknown>) => {
    const started = performance.now();
    await run();
    log(`teardown: ${what} took ${Math.round(performance.now() - started)} ms`);
  };
  if (supervisor && supervisor.exitCode === null)
    await step("stopping the supervisor", async () => {
      supervisor.kill("SIGTERM");
      const stopped = await Promise.race([
        supervisor.exited.then(() => true),
        Bun.sleep(stopMs).then(() => false),
      ]);
      if (!stopped) {
        log(`teardown: the supervisor outlived ${stopMs} ms; killing it`);
        supervisor.kill("SIGKILL");
        await supervisor.exited;
      }
    });
  if (!root) return;
  const where = root;
  await step("stopping what is left under the test folder", async () => {
    for (let pass = 0; pass < 20; pass++) {
      const left = await processesUnder(where);
      if (!left.length) return;
      for (const pid of left) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone already.
        }
      }
      await Bun.sleep(100);
    }
    const left = await processesUnder(where);
    if (left.length)
      throw new Error(`Processes ${left.join(", ")} still run under ${where}.`);
  });
  await step("removing the test folder", () =>
    rm(where, { recursive: true, force: true }),
  );
}
