import path from "node:path";
import { getDataRoot } from "@nimbus/api/data-root";
import { Homes } from "@nimbus/api/homes";
import { PendingChanges } from "@nimbus/api/pending-changes";
import { client, databasePath, db } from "./db";
import { DatabaseFiles } from "./db/database-files";
import { upgradeDatabase } from "./db/migrate-database";
import { createDriveStore } from "./drive-store";
import { DavLockStore } from "./dav-lock-store";
import {
  setFileLockStore,
  setScopeAuthority,
} from "@nimbus/api/file-mutations";
import { handleWebDAV } from "./webdav";
import { cleanExpiredData } from "./maintenance";
import {
  flushAudit,
  recordAudit,
  runWithAuditRequest,
  setAuditSink,
} from "@nimbus/api/audit";
import { AuditRetention, createAuditSink, purgeAuditEvents } from "./audit-log";
import { ClientIp, clientIpHeader, TrustedProxies } from "./client-ip";
import { mailConfig } from "./mail";
import { EventStreams } from "./event-streams";
import { SecurityHeaders } from "./security-headers";
import { HttpRoutes } from "./http-routes";
import { AppShell } from "./app-shell";
import { AuthPages } from "./auth-pages";
import { PageBootstrap } from "./page-bootstrap";
import { PageSkeleton } from "./page-skeleton";
import { PublicPages } from "./public-pages";
import { SameSiteRedirect } from "./same-site-redirect";
import { backups, backupsToKeep } from "./backup";
import { readMcpConfig } from "./mcp/config";
import { getConfigRoot, requireDataRoot } from "./storage-paths";
import { ensureFileWatcher, stopFileWatcher } from "./file-watcher";
import { watchLibraryCatalogs } from "./libraries/library-runtime";
import { Transfers } from "./libraries/transfers";
import { searchIndexed } from "./search-bridge";
import { GET as readiness } from "./routes/health";
import { Supervision, type LifecycleMessage } from "./supervisor/supervision";
import { ServerRun } from "@nimbus/api/server-run";
import { InstallationLock } from "./installation-lock";
import { MigrationGate } from "./db/migration-gate";
import { NEEDS_FULL_RESTART_EXIT } from "./supervisor/protocol";
import { GuessBudgets } from "./guess-budgets";

const startedAt = performance.now();
// The run starts now, before any link or receipt is issued, and a bad one stops startup.
ServerRun.current();
// Under the supervisor this server is one of possibly several, replaced without downtime.
const supervised = Supervision.fromProcess();
if (!supervised.ok) throw new Error(supervised.error.message);
const supervision = supervised.value;
/**
 * Work only one server may do, which `active` starts: the server taking new connections scans
 * library catalogs and runs the hourly cleanup. A server with no predecessor is active from
 * the start.
 */
const active = Promise.withResolvers<void>();
const replacing = supervision.kind === "supervised" && supervision.predecessor;
if (!replacing) active.resolve();
/** Set once this server started to drain; see `drain`. */
let draining = false;

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(
    "PORT must be a number between 0 and 65535, where 0 listens on any free port.",
  );
}
// Without BETTER_AUTH_URL the public address is localhost on PORT, unknown before listening.
if (port === 0 && !process.env.BETTER_AUTH_URL) {
  throw new Error(
    "PORT is 0, so Nimbus would listen on a port it cannot know in advance. Set BETTER_AUTH_URL to the address Nimbus is reached at. Nimbus did not start.",
  );
}
if (
  !process.env.BETTER_AUTH_SECRET ||
  process.env.BETTER_AUTH_SECRET.length < 32
) {
  throw new Error(
    "Set BETTER_AUTH_SECRET to a random value of at least 32 characters. Run bun run setup for local setup.",
  );
}
const trustedProxies = TrustedProxies.parse(process.env.NIMBUS_TRUSTED_PROXIES);
const auditRetentionDays = AuditRetention.parse(
  process.env.NIMBUS_AUDIT_RETENTION_DAYS,
);
const homesPath = Homes.containerPath();
const mcp = readMcpConfig();
if (mcp.kind === "misconfigured")
  throw new Error(`Nimbus did not start: ${mcp.message}`);
console.info(
  mailConfig.kind === "smtp"
    ? `Nimbus email is enabled through ${mailConfig.host}:${mailConfig.port}.`
    : "Nimbus email is off. Administrators reset forgotten passwords.",
);
const origin = new URL(
  process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
);
const securityMode = {
  development: process.env.NODE_ENV !== "production",
  https: origin.protocol === "https:",
};
const commonHeaders = SecurityHeaders.common(securityMode);
backupsToKeep();
requireDataRoot();
// On its own, this server holds the installation for its lifetime; the supervisor holds it for
// every server it runs.
const installation =
  supervision.kind === "standalone"
    ? InstallationLock.acquire(getConfigRoot())
    : null;
if (installation && !installation.ok)
  throw new Error(installation.error.message);
DatabaseFiles.requireWritable(client, databasePath);
// Beside an older server, only migrations the release declares safe beside it may run; any
// other means a full restart, which the supervisor makes instead of this handover.
if (replacing) {
  const gate = MigrationGate.check(client);
  if (gate.kind === "full-restart" && supervision.kind === "supervised") {
    console.info(
      `Nimbus needs a full restart rather than one without downtime: ${gate.reason}. Nothing was migrated; the supervisor stops every server and starts this one alone.`,
    );
    supervision.send({ kind: "needs-full-restart", reason: gate.reason });
    process.exit(NEEDS_FULL_RESTART_EXIT);
  }
}
// Live updates and search follow the data root from here on, now that it is known to exist.
ensureFileWatcher();
// A supervised server takes over with search complete, and migrates only then, so a server it
// replaces runs against a newer schema for as short a time as possible.
if (supervision.kind === "supervised") await searchIndexed();
await upgradeDatabase(client, async () =>
  path.join(getConfigRoot(), "backups", (await backups().run()).name),
);
// The config root holds the database and its backups, so it is as private as they are.
DatabaseFiles.restrictDirectory(getConfigRoot());
DatabaseFiles.restrict(databasePath);
setAuditSink(createAuditSink(db));
// WebDAV locks outlive this process, so the next one an update starts honours them.
setFileLockStore(DavLockStore.create(db));
// Password guess budgets and spent codes outlive this process too, so a restart never resets them.
GuessBudgets.keepIn(db);
if (supervision.kind === "supervised") {
  // Every server the supervisor runs takes path scopes from it, so their changes never overlap.
  setScopeAuthority(supervision.scopes);
  // A transfer may be sent by another server than the one where its device or library changed.
  Transfers.relayTo((signal) =>
    supervision.send({ kind: "transfer-signal", signal }),
  );
  supervision.onTransferSignal(Transfers.apply);
}
const store = createDriveStore(db);
// Changes a crash cut between their filesystem and database steps. A server that starts with
// no other on the installation (InstallationLock) recovers all of them before any request:
// whoever recorded them has died. Beside other servers it recovers nothing at startup; the
// supervisor asks it to settle each server's changes once that server has exited.
if (!replacing)
  for (const recovered of await PendingChanges.recover(store, getDataRoot()))
    (recovered.outcome === "unclear" ? console.warn : console.info)(
      PendingChanges.describe(recovered),
    );
const homesContainer = await Homes.prepare(store, homesPath);
if (homesContainer.kind === "refused") throw new Error(homesContainer.message);
if (homesContainer.created)
  console.info(`Nimbus created ${homesContainer.path} to hold home folders.`);
for (const home of await Homes.backfill(store))
  if (home.kind === "failed") console.error(home.message);
  else console.info(`Nimbus created the home folder ${home.path}.`);
let stopCatalogs: (() => void) | null = null;
void active.promise.then(() => {
  if (!draining) stopCatalogs = watchLibraryCatalogs();
});
const shell = await AppShell.start(
  securityMode,
  supervision.kind === "supervised" ? supervision.previousAssets : [],
);
const routes = HttpRoutes.create({ shell, mode: securityMode });
// Aborted at shutdown, which ends live event streams so the server can drain.
const streams = new AbortController();

const textResponse = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

// The MCP consent page grants access with one click, so no OAuth response may be framed.
const unframeable = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

/**
 * Adds `headers` to `response`. Responses from `fetch` and `Response.redirect` have read-only
 * headers, so those are copied; others are changed in place, which keeps file bodies on Bun's
 * zero-copy path.
 */
function withHeaders(
  response: Response,
  headers: Record<string, string>,
  { replace }: { replace: boolean },
) {
  const apply = (target: Headers) => {
    for (const [name, value] of Object.entries(headers))
      if (replace || !target.has(name)) target.set(name, value);
  };
  try {
    apply(response.headers);
    return response;
  } catch {
    const copy = new Headers(response.headers);
    apply(copy);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: copy,
    });
  }
}

/** WebDAV compares Destination URLs with the request URL, which names the public origin. */
function webDavRequest(request: Request, url: URL) {
  return new Request(new URL(url.pathname, origin), request);
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/dav" || pathname.startsWith("/dav/")) {
    // URL parsing splits off a query or fragment, which would retarget a DELETE or MOVE at the
    // parent folder. WebDAV never uses either, so a raw ? or # is a file name sent unencoded.
    if (/[?#]/.test(request.url))
      return textResponse(
        400,
        "WebDAV request URLs cannot contain ? or #. Nothing was changed. Percent-encode them in file names as %3F and %23.",
      );
    return handleWebDAV(webDavRequest(request, url));
  }
  if (HttpRoutes.owns(pathname)) {
    const handler = routes.find(pathname);
    const response = handler
      ? await handler(request)
      : textResponse(
          404,
          `Nothing is served at ${pathname}. Check the address.`,
        );
    if (pathname.startsWith("/oauth/"))
      return withHeaders(response, unframeable, { replace: false });
    // The app compares it with its own, to say when Nimbus was updated while it was open.
    return shell.build && pathname.startsWith("/api/trpc/")
      ? withHeaders(
          response,
          { "Nimbus-Build": shell.build },
          { replace: true },
        )
      : response;
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(`${request.method} is not supported here.`, {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  // In development Vite answers every path, so only documents skip it for the page.
  const page = AppShell.wantsPage(request);
  if (!page || !securityMode.development) {
    const file = await shell.file(request, pathname);
    if (file) return file;
    if (!page) return textResponse(404, `Nothing is served at ${pathname}.`);
  }
  const authPage = await AuthPages.render(request, url, shell, securityMode);
  if (authPage?.kind === "redirect")
    return SameSiteRedirect.response(authPage.location);
  if (authPage)
    return AppShell.htmlResponse(request, authPage.html, authPage.headers);
  const publicPage = await PublicPages.render(
    request,
    pathname,
    shell,
    securityMode,
  );
  if (publicPage)
    return AppShell.htmlResponse(request, publicPage.html, publicPage.headers);
  const kind = shell.route(pathname)?.kind ?? null;
  const bootstrap = await PageBootstrap.load(request, kind);
  if (bootstrap.kind === "redirect")
    return SameSiteRedirect.response(bootstrap.location);
  const nonce = SecurityHeaders.nonce();
  return AppShell.htmlResponse(
    request,
    await shell.html(nonce, pathname, {
      data: bootstrap.data,
      skeleton: PageSkeleton.markup(
        kind,
        bootstrap,
        pathname,
        request.headers.get("cookie"),
      ),
      requests: bootstrap.requests,
    }),
    new Headers(SecurityHeaders.document(nonce, securityMode)),
  );
}

// With reusePort, requests reach a server the moment it listens, so a supervised one listens
// only once its readiness check passes; the server it replaces keeps serving meanwhile.
if (supervision.kind === "supervised")
  for (let attempt = 0; !(await readiness()).ok; attempt++) {
    if (attempt === 0)
      console.error(
        "Nimbus waits for its readiness check to pass before it listens; the server it replaces keeps serving meanwhile.",
      );
    await Bun.sleep(1000);
  }

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  // Lets the next server listen on the same port before this one leaves it.
  reusePort: supervision.kind === "supervised",
  development: false,
  // Bun's maximum. Event streams opt out of the timeout entirely.
  idleTimeout: 255,
  // Uploads stream to disk, so the body size is limited by storage, not memory.
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  async fetch(request, server) {
    // Derive the client address once, from the socket and trusted proxies only.
    const ip = ClientIp.resolve(
      server.requestIP(request)?.address,
      request.headers.get("x-forwarded-for") ?? undefined,
      trustedProxies,
    );
    request.headers.set(clientIpHeader, ip);
    const userAgent = request.headers.get("user-agent") ?? undefined;
    const events = EventStreams.requested(request);
    const incoming = events
      ? new Request(request, {
          signal: AbortSignal.any([request.signal, streams.signal]),
        })
      : request;
    try {
      const response = await runWithAuditRequest({ ip, userAgent }, () =>
        route(incoming),
      );
      // Only once the answer is an event stream; reading the request stays under the timeout.
      if (EventStreams.untimed(request, response)) server.timeout(request, 0);
      return withHeaders(response, commonHeaders, { replace: true });
    } catch (error) {
      // Query strings and MCP upload link paths carry credentials, so neither is logged.
      console.error(
        `Nimbus request failed: ${request.method} ${new URL(request.url).pathname.replace(/^(\/api\/mcp\/upload\/).*/, "$1…")}`,
        error,
      );
      return withHeaders(
        textResponse(
          500,
          "The request failed. Check the server logs and try again.",
        ),
        commonHeaders,
        { replace: true },
      );
    }
  },
});
console.info(`Nimbus is ready at http://localhost:${server.port}`);

let pendingCleanup: Promise<void> | undefined;
function cleanup() {
  pendingCleanup ??= Promise.all([
    cleanExpiredData(store, getDataRoot()),
    purgeAuditEvents(db, auditRetentionDays),
  ])
    .then(() => undefined)
    .catch((error: unknown) =>
      console.error(
        "Nimbus retention cleanup failed. Remaining items will be retried in one hour.",
        error,
      ),
    )
    .then(() => backups().runIfDue())
    .then((backup) => {
      if (backup)
        recordAudit({
          action: "backup.created",
          actor: { type: "system" },
          target: { type: "backup", id: backup.name },
          details: { size: backup.size, scheduled: true },
        });
    })
    .catch((error: unknown) =>
      console.error(
        "Nimbus daily database backup failed. The database and earlier backups are unchanged; it will be retried in one hour.",
        error,
      ),
    )
    .finally(() => {
      pendingCleanup = undefined;
    });
  return pendingCleanup;
}
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
void active.promise.then(() => {
  if (draining) return;
  void cleanup();
  cleanupTimer = setInterval(() => void cleanup(), 60 * 60 * 1000);
  cleanupTimer.unref();
});

/**
 * Stop accepting connections, and finish what was started: graceful `server.stop()` closes the
 * listener at once and resolves once every response already started has been sent, however
 * long that takes, such as a film streamed to a player. Live event streams end now, so their
 * clients reconnect to the next server. Work this server no longer needs stops too: the file
 * watcher, the search index and its worker, catalog scans and the hourly cleanup. What open
 * responses need stays: their file descriptors, the database, and the checks between chunks
 * that cut off a disconnected device. Past `deadline` (epoch milliseconds) the remaining
 * responses are cut. A later call may bring the deadline forward.
 */
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
let deadlineAt = Number.POSITIVE_INFINITY;
function drain(deadline: number) {
  if (deadline < deadlineAt) {
    deadlineAt = deadline;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(
      () => {
        console.error(
          `Nimbus reached its drain deadline with ${server.pendingRequests} responses still being sent. Closing their connections.`,
        );
        void server.stop(true);
        void finish(true);
      },
      Math.max(0, deadline - Date.now()),
    );
  }
  if (draining) return;
  draining = true;
  const stopped = server.stop();
  streams.abort();
  if (cleanupTimer) clearInterval(cleanupTimer);
  stopCatalogs?.();
  stopFileWatcher();
  // Give back what the stopped work held, once the search worker has ended.
  setTimeout(() => Bun.gc(true), 2_000).unref();
  if (supervision.kind === "supervised") {
    const report = () =>
      supervision.send({ kind: "in-flight", count: server.pendingRequests });
    report();
    setInterval(report, 10_000).unref();
  }
  void stopped.then(() => finish(false));
}

let finishing: Promise<void> | null = null;
function finish(forced: boolean) {
  // Past the deadline nothing more is waited for, not even cleanup still running.
  if (forced) {
    if (supervision.kind === "supervised")
      supervision.send({ kind: "drained", forced });
    client.close();
    process.exit(1);
  }
  finishing ??= (async () => {
    await pendingCleanup;
    await flushAudit();
    client.close();
    if (supervision.kind === "supervised")
      supervision.send({ kind: "drained", forced: false });
    process.exit(0);
  })().catch((error: unknown) => {
    console.error("Nimbus shutdown failed.", error);
    process.exit(1);
  });
  return finishing;
}

// On its own, a stop signal drains for 30 seconds, as a container stop allows.
const shutdown = () => drain(Date.now() + 30_000);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/**
 * Settle what an exited server process left unfinished. Its fence stays up until the changes
 * inside it are settled, so a failure is retried rather than given up: the paths involved wait.
 */
async function settleFor(
  message: Extract<LifecycleMessage, { kind: "recover" }>,
): Promise<void> {
  if (supervision.kind !== "supervised") return;
  const { send } = supervision;
  try {
    for (const recovered of await PendingChanges.recoverOwned(
      store,
      getDataRoot(),
      message.owner,
      message.fence,
      () => send({ kind: "fence-done", id: message.id }),
    ))
      (recovered.outcome === "unclear" ? console.warn : console.info)(
        PendingChanges.describe(recovered),
      );
  } catch (error) {
    console.error(
      `Nimbus could not settle the changes server process ${message.owner} left unfinished, so the items involved stay locked; it tries again in 10 seconds.`,
      error,
    );
    await Bun.sleep(10_000);
    if (!draining) await settleFor(message);
  }
}

if (supervision.kind === "supervised") {
  supervision.onLifecycle((message) => {
    switch (message.kind) {
      case "drain":
        drain(message.deadline);
        return;
      case "active":
        active.resolve();
        return;
      case "recover":
        void settleFor(message);
        return;
    }
  });
  // Without its supervisor nothing can hand this server over: it stops as a container would.
  supervision.onDisconnect(shutdown);
  supervision.send({
    kind: "ready",
    build: shell.build,
    startupMs: Math.round(performance.now() - startedAt),
  });
}
