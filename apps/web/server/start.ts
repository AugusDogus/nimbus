import path from "node:path";
import { getDataRoot } from "@nimbus/api/data-root";
import { Homes } from "@nimbus/api/homes";
import { PendingChanges } from "@nimbus/api/pending-changes";
import { client, databasePath, db } from "./db";
import { DatabaseFiles } from "./db/database-files";
import { upgradeDatabase } from "./db/migrate-database";
import { createDriveStore } from "./drive-store";
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
import { SecurityHeaders } from "./security-headers";
import { HttpRoutes } from "./http-routes";
import { AppShell } from "./app-shell";
import { AuthPages } from "./auth-pages";
import { PageBootstrap } from "./page-bootstrap";
import { PageSkeleton } from "./page-skeleton";
import { PublicPages } from "./public-pages";
import { backups, backupsToKeep } from "./backup";
import { readMcpConfig } from "./mcp/config";
import { getConfigRoot } from "./storage-paths";

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a number between 1 and 65535.");
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
DatabaseFiles.requireWritable(client, databasePath);
await upgradeDatabase(client, async () =>
  path.join(getConfigRoot(), "backups", (await backups().run()).name),
);
// The config root holds the database and its backups, so it is as private as they are.
DatabaseFiles.restrictDirectory(getConfigRoot());
DatabaseFiles.restrict(databasePath);
setAuditSink(createAuditSink(db));
const store = createDriveStore(db);
// Before any request: changes a crash cut between their filesystem and database steps.
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
const shell = await AppShell.start(securityMode);
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
    return pathname.startsWith("/oauth/")
      ? withHeaders(response, unframeable, { replace: false })
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
    return Response.redirect(new URL(authPage.location, request.url), 307);
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
    return Response.redirect(new URL(bootstrap.location, request.url), 307);
  const nonce = SecurityHeaders.nonce();
  return AppShell.htmlResponse(
    request,
    await shell.html(nonce, pathname, {
      data: bootstrap.data,
      skeleton: PageSkeleton.markup(kind, bootstrap),
      requests: bootstrap.requests,
    }),
    new Headers(SecurityHeaders.document(nonce, securityMode)),
  );
}

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
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
    const events = request.headers.get("accept")?.includes("text/event-stream");
    if (events) server.timeout(request, 0);
    const incoming = events
      ? new Request(request, {
          signal: AbortSignal.any([request.signal, streams.signal]),
        })
      : request;
    try {
      const response = await runWithAuditRequest({ ip, userAgent }, () =>
        route(incoming),
      );
      return withHeaders(response, commonHeaders, { replace: true });
    } catch (error) {
      // Query strings can carry credentials, such as MCP download link tokens.
      console.error(
        `Nimbus request failed: ${request.method} ${new URL(request.url).pathname}`,
        error,
      );
      return textResponse(
        500,
        "The request failed. Check the server logs and try again.",
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
void cleanup();
const cleanupTimer = setInterval(() => void cleanup(), 60 * 60 * 1000);
cleanupTimer.unref();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanupTimer);
  streams.abort();
  const deadline = setTimeout(() => {
    console.error(
      "Nimbus shutdown exceeded 30 seconds. Closing remaining connections.",
    );
    void server.stop(true);
    client.close();
    process.exit(1);
  }, 30_000);
  deadline.unref();
  void (async () => {
    await server.stop();
    await pendingCleanup;
    await flushAudit();
    client.close();
    clearTimeout(deadline);
    process.exit(0);
  })().catch((error: unknown) => {
    console.error("Nimbus shutdown failed.", error);
    process.exit(1);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
