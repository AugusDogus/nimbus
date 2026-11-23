/**
 * Drives traffic at Nimbus under the supervisor while it restarts without downtime, and reports
 * what clients saw. For manual runs; the automated check is handover.e2e.test.ts.
 *
 *   NIMBUS_DATA_ROOT=... BETTER_AUTH_URL=http://localhost:3000 \
 *     bun apps/web/server/supervisor/handover-harness.ts \
 *     --origin http://127.0.0.1:3000 --control /tmp/nimbus-supervisor/control.sock \
 *     --handovers 4 --media <large file in the data root>
 *
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
 *   changes a file in the data root every 250 ms;
 * - upload: a tus upload in 1 MiB PATCH chunks, resumed with HEAD when a chunk fails.
 *
 * "failed" counts every request that got a network error or an unexpected status: a real
 * client would have shown an error or had to retry. "gap" is the longest time a workload went
 * without progress (bytes, answers or events).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

const { values: args } = parseArgs({
  options: {
    origin: { type: "string", default: "http://127.0.0.1:21800" },
    control: { type: "string" },
    releases: { type: "string", default: "" },
    handovers: { type: "string", default: "4" },
    interval: { type: "string", default: "6000" },
    media: { type: "string", default: "sample-video.bin" },
    "media-rate": { type: "string", default: "40" },
    email: { type: "string", default: "admin@example.test" },
    password: { type: "string", default: "spike-password-0123456789" },
  },
});
const origin = args.origin;
// Sent as Origin: the address Nimbus believes it is reached at, which sign-in checks.
const publicOrigin = process.env.BETTER_AUTH_URL ?? origin;
const control = args.control;
if (!control)
  throw new Error("Pass --control <path to the supervisor socket>.");
const releases = args.releases.split(",").filter(Boolean);
const handovers = Number(args.handovers);
const intervalMs = Number(args.interval);
const mediaBytesPerSecond = Number(args["media-rate"]) * 1024 * 1024;
const dataRoot = process.env.NIMBUS_DATA_ROOT;
if (!dataRoot)
  throw new Error("Set NIMBUS_DATA_ROOT to the server's data root.");

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
async function session(): Promise<string> {
  const headers = { "content-type": "application/json", origin: publicOrigin };
  const signIn = () =>
    fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: args.email, password: args.password }),
    });
  let response = await signIn();
  if (!response.ok) {
    const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Spike Administrator",
        email: args.email,
        password: args.password,
      }),
    });
    if (!signUp.ok)
      throw new Error(
        `Could not sign in or create ${args.email}: ${signUp.status} ${await signUp.text()}`,
      );
    response = await signIn();
  }
  const cookies = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  if (!cookies) throw new Error("Signing in returned no session cookie.");
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
  const url = `${origin}/api/files/download?path=${encodeURIComponent(args.media)}`;
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
      for await (const chunk of response.body) {
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
  const url = `${origin}/api/files/download?path=${encodeURIComponent(args.media)}`;
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
  const url = `${origin}/api/trpc/files.onChange?input=${encodeURIComponent(JSON.stringify({ path: "spike" }))}`;
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
      for await (const chunk of response.body) {
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
  const folder = path.join(dataRoot ?? "", "spike");
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
              meta("targetPath", "spike"),
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
const Report = z.object({
  from: z.string(),
  to: z.string(),
  readyMs: z.number(),
  draining: z.object({ pid: z.number(), deadline: z.string() }),
});
type Report = z.infer<typeof Report>;
const Status = z.object({
  active: z.object({ release: z.string() }).nullable(),
  draining: z.array(
    z.object({ pid: z.number(), inFlight: z.number().nullable() }),
  ),
});
const status = async () =>
  Status.parse(
    await (await fetch("http://supervisor/status", { unix: control })).json(),
  );
async function handover(release: string | null): Promise<Report | string> {
  const response = await fetch(
    release === null
      ? "http://supervisor/handover"
      : `http://supervisor/handover?release=${encodeURIComponent(release)}`,
    { method: "POST", unix: control },
  );
  const body: unknown = await response.json();
  const report = Report.safeParse(body);
  return response.ok && report.success ? report.data : JSON.stringify(body);
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
  const active = releases.indexOf((await status()).active?.release ?? "");
  const release = releases.length
    ? (releases[(active + 1) % releases.length] ?? null)
    : null;
  const started = performance.now();
  const report = await handover(release);
  reports.push(report);
  console.info(
    `handover ${i + 1} to ${release ?? "a fresh server"}: ${typeof report === "string" ? report : `ready in ${Math.round(report.readyMs)} ms; pid ${report.draining.pid} drains`} [${Math.round(performance.now() - started)} ms round trip]`,
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
process.exit(0);
