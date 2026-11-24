/**
 * Drives traffic at Nimbus under the supervisor while it restarts without downtime, and reports
 * what clients saw. For manual runs on a test installation; the automated check is
 * apps/web/server/supervisor/handover.e2e.test.ts. Not part of the image.
 *
 *   bun scripts/handover-harness.ts prepare --data-root /var/tmp/harness-data
 *   # start Nimbus under the supervisor on that data root, create a test account, then:
 *   HARNESS_PASSWORD=... bun scripts/handover-harness.ts run \
 *     --base-url http://127.0.0.1:3000 --control /tmp/nimbus-supervisor/control.sock \
 *     --data-root /var/tmp/harness-data --email tester@example.test \
 *     --media <large file in the data root> --handovers 4
 *
 * `prepare` makes a new data root and marks it as the harness's; `run` refuses a data root it
 * did not prepare unless given `--existing-data-root`, signs in with the account it is given
 * and never creates one, and writes only in a scratch folder of its own, removed at the end.
 * Without `--releases`, each handover restarts the running release in place; with
 * `--releases a,b` it alternates between releases in NIMBUS_RELEASES_DIR.
 *
 * Workloads, all running through every handover:
 * - media: one open-ended `Range: bytes=N-` read at a set rate, as a video player streams. It
 *   should never be cut: the server that started it finishes it. A cut counts as a failure and
 *   is reopened where it stopped, as players do;
 * - ranges: bounded 8 MiB range requests one after another, as players that fetch in pieces do;
 * - api: concurrent loops of a tRPC query and the health check on fresh and reused connections;
 * - events: the tRPC files.onChange subscription, reconnecting when it ends, while the harness
 *   changes a file in its scratch folder every 250 ms;
 * - upload: a tus upload in 1 MiB PATCH chunks into the scratch folder, resumed with HEAD when a
 *   chunk fails.
 *
 * "failed" counts every request that got a network error or an unexpected status: a real
 * client would have shown an error or had to retry. "gap" is the longest time a workload went
 * without progress (bytes, answers or events).
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ControlClient } from "../apps/web/server/supervisor/control-client";

/** The chunks of `body`, each checked to be bytes. */
async function* bytes(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value instanceof Uint8Array) yield value;
  }
}

async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "base-url": { type: "string" },
    "public-origin": { type: "string" },
    control: { type: "string" },
    "data-root": { type: "string" },
    "existing-data-root": { type: "boolean", default: false },
    releases: { type: "string", default: "" },
    handovers: { type: "string", default: "4" },
    interval: { type: "string", default: "6000" },
    media: { type: "string" },
    "media-rate": { type: "string", default: "40" },
    email: { type: "string" },
  },
});

const refuse = (message: string): never => {
  console.error(message);
  process.exit(2);
};
/** Marks a data root the harness made, so it never writes into one it was not given for it. */
const marker = ".handover-harness";
const [command] = positionals;
const dataRoot =
  args["data-root"] ??
  refuse("Pass --data-root <the test installation's data root>.");

if (command === "prepare") {
  if (await exists(dataRoot))
    refuse(
      `${dataRoot} already exists, so the harness did not prepare it. Choose a new folder for a test installation.`,
    );
  await mkdir(dataRoot, { recursive: true });
  await writeFile(
    path.join(dataRoot, marker),
    "made by scripts/handover-harness.ts\n",
  );
  console.info(
    `Prepared ${dataRoot}. Start Nimbus under the supervisor with NIMBUS_DATA_ROOT=${dataRoot}, create a test account, then use run.`,
  );
  process.exit(0);
}
if (command !== "run")
  refuse(
    "Usage: bun scripts/handover-harness.ts prepare|run --data-root <folder> ...",
  );
if (!args["existing-data-root"] && !(await exists(path.join(dataRoot, marker))))
  refuse(
    `The harness did not prepare ${dataRoot}, so it does not write there. Use a data root from prepare, or pass --existing-data-root for a test installation you chose on purpose.`,
  );
const origin =
  args["base-url"] ??
  refuse(
    "Pass --base-url <the test installation's address>, such as http://127.0.0.1:3000.",
  );
// Sent as Origin: the address Nimbus believes it is reached at, which sign-in checks.
const publicOrigin = args["public-origin"] ?? origin;
const control =
  args.control ?? refuse("Pass --control <path to the supervisor socket>.");
const email =
  args.email ??
  refuse("Pass --email <a test account that exists on the installation>.");
const password =
  process.env.HARNESS_PASSWORD ??
  refuse("Set HARNESS_PASSWORD to the test account's password.");
const mediaPath =
  args.media ??
  refuse("Pass --media <a large file in the data root, relative to it>.");
const releases = args.releases.split(",").filter(Boolean);
const handovers = Number(args.handovers);
const intervalMs = Number(args.interval);
const mediaBytesPerSecond = Number(args["media-rate"]) * 1024 * 1024;
/** This run's own folder in the data root: everything it writes, removed at the end. */
const scratch = `handover-harness-${Date.now()}-${randomBytes(4).toString("hex")}`;
await mkdir(path.join(dataRoot, scratch));

type Stats = {
  ok: number;
  failed: number;
  failures: Map<string, number>;
  lastProgress: number;
  longestGapMs: number;
  notes: Map<string, number>;
};
const workloads = new Map<string, Stats>();
const stats = (name: string): Stats => {
  let found = workloads.get(name);
  if (!found) {
    found = {
      ok: 0,
      failed: 0,
      failures: new Map(),
      lastProgress: 0,
      longestGapMs: 0,
      notes: new Map(),
    };
    workloads.set(name, found);
  }
  return found;
};
const bump = (map: Map<string, number>, key: string) =>
  map.set(key, (map.get(key) ?? 0) + 1);
let measuring = false;
function progress(s: Stats) {
  const now = performance.now();
  if (measuring && s.lastProgress)
    s.longestGapMs = Math.max(s.longestGapMs, now - s.lastProgress);
  s.lastProgress = now;
}
const fail = (s: Stats, reason: string) => {
  s.failed++;
  bump(s.failures, reason.slice(0, 90));
};
const describe = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

let running = true;
const stop = new AbortController();

// --- account -------------------------------------------------------------------------------
/** Sign in with the given test account; the harness never creates one. */
async function session(): Promise<string> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: publicOrigin },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok)
    refuse(
      `Signing in as ${email} failed (${response.status} ${await response.text()}). Create that test account first; the harness never creates accounts.`,
    );
  const cookies = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  if (!cookies) refuse("Signing in returned no session cookie.");
  return cookies;
}
const cookie = await session();
const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { cookie, origin: publicOrigin, ...init.headers },
  signal: stop.signal,
});

// --- media: open-ended range, read at a fixed rate, reopened where it stopped ----------------
async function media() {
  const s = stats("media");
  const url = `${origin}/api/files/download?path=${encodeURIComponent(mediaPath)}`;
  let offset = 0;
  while (running) {
    try {
      const response = await fetch(
        url,
        authed({ headers: { range: `bytes=${offset}-` } }),
      );
      if (response.status !== 206 || !response.body) {
        fail(s, `status ${response.status}`);
        await Bun.sleep(100);
        continue;
      }
      s.ok++;
      const started = performance.now();
      let read = 0;
      for await (const chunk of bytes(response.body)) {
        read += chunk.byteLength;
        offset += chunk.byteLength;
        progress(s);
        if (!running) break;
        // Read no faster than a player decoding at mediaBytesPerSecond would.
        const ahead =
          started + (read / mediaBytesPerSecond) * 1000 - performance.now();
        if (ahead > 0) await Bun.sleep(ahead);
      }
      if (!running) break;
      // The file ended: start over, as a looping player would.
      offset = 0;
      bump(s.notes, "reached end, restarted");
    } catch (error) {
      if (!running) break;
      fail(s, describe(error));
      bump(s.notes, "reopened from offset after a cut");
    }
  }
}

// --- ranges: bounded 8 MiB requests one after another ----------------------------------------
async function ranges() {
  const s = stats("ranges");
  const url = `${origin}/api/files/download?path=${encodeURIComponent(mediaPath)}`;
  const piece = 8 * 1024 * 1024;
  let offset = 0;
  while (running) {
    try {
      const response = await fetch(
        url,
        authed({ headers: { range: `bytes=${offset}-${offset + piece - 1}` } }),
      );
      if (response.status === 416) {
        offset = 0;
        continue;
      }
      if (response.status !== 206) {
        fail(s, `status ${response.status}`);
        continue;
      }
      const body = await response.arrayBuffer();
      offset += body.byteLength;
      s.ok++;
      progress(s);
      await Bun.sleep(20);
    } catch (error) {
      if (running) fail(s, describe(error));
    }
  }
}

// --- api: small requests, on reused and on fresh connections ---------------------------------
async function api(fresh: boolean) {
  const s = stats(fresh ? "api (new connection each)" : "api (keep-alive)");
  const list = `${origin}/api/trpc/files.list?input=${encodeURIComponent(JSON.stringify({ path: "projects/folder-1" }))}`;
  let turn = 0;
  while (running) {
    const target = turn++ % 2 ? `${origin}/api/health` : list;
    try {
      const response = await fetch(
        target,
        authed(
          fresh ? { headers: { connection: "close" }, keepalive: false } : {},
        ),
      );
      await response.arrayBuffer();
      if (!response.ok)
        fail(s, `status ${response.status} for ${new URL(target).pathname}`);
      else {
        s.ok++;
        progress(s);
      }
    } catch (error) {
      if (running) fail(s, describe(error));
    }
  }
}

// --- events: the tRPC subscription, reconnecting when it ends --------------------------------
const changesWritten = { count: 0 };
async function events() {
  const s = stats("events");
  const url = `${origin}/api/trpc/files.onChange?input=${encodeURIComponent(JSON.stringify({ path: scratch }))}`;
  while (running) {
    try {
      const response = await fetch(
        url,
        authed({ headers: { accept: "text/event-stream" } }),
      );
      if (!response.ok || !response.body) {
        fail(s, `status ${response.status}`);
        await Bun.sleep(250);
        continue;
      }
      s.ok++;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of bytes(response.body)) {
        buffer += decoder.decode(chunk, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (
            /^data: /m.test(event) &&
            !/^event: (connected|ping)/m.test(event)
          ) {
            bump(s.notes, "change events received");
            progress(s);
          }
          end = buffer.indexOf("\n\n");
        }
      }
      // The server ended the stream (as a draining worker does); reconnect like the client.
      if (running) bump(s.notes, "stream ended by server, reconnected");
    } catch (error) {
      if (running) {
        fail(s, describe(error));
        await Bun.sleep(250);
      }
    }
  }
}
async function changeFiles() {
  const folder = path.join(dataRoot, scratch);
  await mkdir(folder, { recursive: true });
  while (running) {
    await writeFile(
      path.join(folder, "change.txt"),
      String(changesWritten.count++),
    );
    await Bun.sleep(250);
  }
}

// --- upload: tus in 1 MiB chunks, resumed with HEAD after a failed chunk ---------------------
async function upload() {
  const s = stats("upload");
  const chunk = new Uint8Array(1024 * 1024).fill(97);
  const size = 48 * chunk.byteLength;
  const tus = { "tus-resumable": "1.0.0" };
  const meta = (key: string, value: string) =>
    `${key} ${Buffer.from(value).toString("base64")}`;
  let n = 0;
  while (running) {
    const filename = `upload-${process.pid}-${n++}.bin`;
    let location: string | null = null;
    try {
      const created = await fetch(
        `${origin}/api/upload`,
        authed({
          method: "POST",
          headers: {
            ...tus,
            "upload-length": String(size),
            "upload-metadata": [
              meta("filename", filename),
              meta("targetPath", scratch),
              meta("conflict", "keep-both"),
            ].join(","),
          },
        }),
      );
      location = created.headers.get("location");
      if (created.status !== 201 || !location) {
        fail(s, `create: status ${created.status} ${await created.text()}`);
        await Bun.sleep(500);
        continue;
      }
      s.ok++;
    } catch (error) {
      if (running) fail(s, `create: ${describe(error)}`);
      continue;
    }
    const target = new URL(location, origin).toString();
    let offset = 0;
    while (running && offset < size) {
      try {
        const response = await fetch(
          target,
          authed({
            method: "PATCH",
            headers: {
              ...tus,
              "upload-offset": String(offset),
              "content-type": "application/offset+octet-stream",
            },
            body: chunk,
          }),
        );
        if (response.status !== 204) {
          fail(s, `patch: status ${response.status} ${await response.text()}`);
        } else {
          s.ok++;
          offset = Number(response.headers.get("upload-offset"));
          progress(s);
          await Bun.sleep(100);
          continue;
        }
      } catch (error) {
        if (!running) break;
        fail(s, `patch: ${describe(error)}`);
      }
      // Ask where the server stands, as tus-js-client does before retrying.
      try {
        const head = await fetch(
          target,
          authed({ method: "HEAD", headers: tus }),
        );
        offset = Number(head.headers.get("upload-offset") ?? offset);
        bump(s.notes, "resumed after HEAD");
      } catch (error) {
        if (running) fail(s, `head: ${describe(error)}`);
      }
    }
    if (offset >= size) bump(s.notes, "uploads completed");
  }
}

// --- handovers -----------------------------------------------------------------------------
type Report = {
  readyMs: number;
  draining: { pid: number } | null;
  fullRestart: string | null;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
/** The active release and what drains, from the supervisor's status. */
async function status() {
  const body: unknown = await (await ControlClient.status(control)).json();
  const active =
    isRecord(body) &&
    isRecord(body.active) &&
    typeof body.active.release === "string"
      ? body.active.release
      : "";
  const draining =
    isRecord(body) && Array.isArray(body.draining) ? body.draining : [];
  return { active, draining };
}
async function handover(release: string | null): Promise<Report | string> {
  const done = await ControlClient.handover(control, release);
  if (!done) return "the answer ended without its outcome";
  return done.ok ? done.report : JSON.stringify(done.error);
}

const work = [
  media(),
  ranges(),
  api(false),
  api(false),
  api(true),
  api(true),
  events(),
  changeFiles(),
  upload(),
];
await Bun.sleep(2000);
measuring = true;
const reports: (Report | string)[] = [];
for (let i = 0; i < handovers; i++) {
  // In place, or the release after the active one, so a refused handover is not repeated.
  const active = releases.indexOf((await status()).active);
  const release = releases.length
    ? (releases[(active + 1) % releases.length] ?? null)
    : null;
  const started = performance.now();
  const report = await handover(release);
  reports.push(report);
  console.info(
    `handover ${i + 1} to ${release ?? "a fresh server"}: ${typeof report === "string" ? report : `ready in ${Math.round(report.readyMs)} ms; ${report.fullRestart ? `full restart: ${report.fullRestart}` : report.draining ? `pid ${report.draining.pid} drains` : "nothing to drain"}`} [${Math.round(performance.now() - started)} ms round trip]`,
  );
  await Bun.sleep(intervalMs);
}
console.info(
  `still draining at the end: ${JSON.stringify((await status()).draining)}`,
);
running = false;
measuring = false;
stop.abort();
await Promise.allSettled(work);

const rows = [...workloads].map(([name, s]) => ({
  workload: name,
  ok: s.ok,
  failed: s.failed,
  longestGapMs: Math.round(s.longestGapMs),
  notes: Object.fromEntries(s.notes),
  failures: Object.fromEntries(s.failures),
}));
console.info(
  JSON.stringify(
    {
      handovers: reports,
      changesWritten: changesWritten.count,
      workloads: rows,
    },
    null,
    2,
  ),
);
const failed = rows.reduce((sum, row) => sum + row.failed, 0);
console.info(
  `\nTOTAL failed requests: ${failed}; longest gap: ${Math.max(...rows.map((row) => row.longestGapMs))} ms`,
);
// Everything this run wrote lives in its scratch folder.
await rm(path.join(dataRoot, scratch), { recursive: true, force: true });
process.exit(0);
