import type { AppShell } from "./app-shell";
import { pathSegments, route, type Route } from "./http-route";
import type { SecurityMode } from "./security-headers";
import * as auth from "./routes/auth";
import * as backupFile from "./routes/backup-file";
import * as backups from "./routes/backups";
import { Discovery } from "./routes/discovery";
import * as fileRequest from "./routes/file-request";
import * as fileRequestUpload from "./routes/file-request-upload";
import * as filesArchive from "./routes/files-archive";
import * as filesContent from "./routes/files-content";
import * as filesDownload from "./routes/files-download";
import * as filesThumbnail from "./routes/files-thumbnail";
import * as filesVersion from "./routes/files-version";
import * as health from "./routes/health";
import * as healthLive from "./routes/health-live";
import * as mcp from "./routes/mcp";
import * as mcpConnection from "./routes/mcp-connection";
import * as mcpDownload from "./routes/mcp-download";
import * as mcpUpload from "./routes/mcp-upload";
import * as oauthAuthorize from "./routes/oauth-authorize";
import * as oauthConsent from "./routes/oauth-consent";
import * as oauthConsentDecision from "./routes/oauth-consent-decision";
import * as oauthRegister from "./routes/oauth-register";
import * as oauthRevoke from "./routes/oauth-revoke";
import * as oauthToken from "./routes/oauth-token";
import * as share from "./routes/share";
import * as shareThumbnail from "./routes/share-thumbnail";
import * as trpc from "./routes/trpc";
import * as upload from "./routes/upload";
import { RequestBody } from "./request-body";

const none = () => ({});
// Uploads stream to disk and file saves stream under their own cap; these endpoints buffer
// JSON, so their bodies are capped before they are read. Sign-in and passkey payloads are a
// few KB. tRPC batches at most 16 small mutations from the file browser.
const authBodyBytes = 64 * 1024;
const trpcBodyBytes = 1024 * 1024;
const discovery = {
  authorizationServer: {
    GET: Discovery.authorizationServer,
    OPTIONS: Discovery.preflight,
  },
  protectedResource: {
    GET: Discovery.protectedResource,
    OPTIONS: Discovery.preflight,
  },
};

/** What server-rendered pages need: the app's stylesheets and the security mode. */
type PageContext = { shell: AppShell; mode: SecurityMode };

// Literal segments come before parameters that could also match them.
const routes = ({ shell, mode }: PageContext): Route[] => [
  route("/api/auth/*", none, {
    GET: RequestBody.capped(authBodyBytes, auth.GET),
    POST: RequestBody.capped(authBodyBytes, auth.POST),
  }),
  route("/api/backups", none, {
    GET: backups.GET,
    POST: RequestBody.capped(RequestBody.smallJsonBytes, backups.POST),
  }),
  route("/api/backups/:name", ([name]) => ({ name }), backupFile),
  route("/api/file-request/upload/*?", none, fileRequestUpload),
  route("/api/file-request/:token", ([token]) => ({ token }), fileRequest),
  route("/api/files/archive", none, filesArchive),
  route("/api/files/content", none, filesContent),
  route("/api/files/download", none, filesDownload),
  route("/api/files/thumbnail", none, filesThumbnail),
  route("/api/files/version", none, filesVersion),
  route("/api/health", none, health),
  route("/api/health/live", none, healthLive),
  route("/api/mcp", none, mcp),
  route("/api/mcp/connections/:id", ([id]) => ({ id }), mcpConnection),
  route("/api/mcp/download", none, mcpDownload),
  // Streams to disk like the other uploads, so its body is not capped.
  route(
    "/api/mcp/upload/:token/*?",
    ([token = "", rest = ""]) => ({ token, rest }),
    mcpUpload,
  ),
  route(
    "/api/share/:token/thumbnail",
    ([token]) => ({ token }),
    shareThumbnail,
  ),
  route("/api/share/:token", ([token]) => ({ token }), share),
  route("/api/trpc/:procedures", none, {
    GET: RequestBody.capped(trpcBodyBytes, trpc.GET),
    HEAD: RequestBody.capped(trpcBodyBytes, trpc.HEAD),
    POST: RequestBody.capped(trpcBodyBytes, trpc.POST),
  }),
  route("/api/upload/*?", none, upload),
  route("/oauth/authorize", none, oauthAuthorize),
  route("/oauth/consent", none, {
    GET: (request) => oauthConsent.GET(request, shell, mode),
  }),
  route("/oauth/consent/decision", none, oauthConsentDecision),
  route("/oauth/register", none, oauthRegister),
  route("/oauth/revoke", none, oauthRevoke),
  route("/oauth/token", none, oauthToken),
  route(
    "/.well-known/oauth-authorization-server",
    none,
    discovery.authorizationServer,
  ),
  route(
    "/.well-known/openid-configuration",
    none,
    discovery.authorizationServer,
  ),
  route(
    "/.well-known/oauth-protected-resource",
    none,
    discovery.protectedResource,
  ),
  route(
    "/.well-known/oauth-protected-resource/api/mcp",
    none,
    discovery.protectedResource,
  ),
];

/** Path prefixes that belong to the server. Unknown paths under them are 404, never the app. */
const serverPrefixes = ["/api/", "/oauth/", "/.well-known/"];

export type HttpRoutes = {
  /** The handler for `pathname`, or null when no endpoint matches. */
  find(pathname: string): ((request: Request) => Promise<Response>) | null;
};

/** The server's API, OAuth and discovery endpoints, matched in order. */
export const HttpRoutes = {
  create(context: PageContext): HttpRoutes {
    const table = routes(context);
    return {
      // A path with a malformed percent-encoding matches nothing.
      find(pathname) {
        const segments = pathSegments(pathname);
        if (!segments) return null;
        for (const candidate of table) {
          const handler = candidate.match(segments);
          if (handler) return handler;
        }
        return null;
      },
    };
  },
  /** Whether `pathname` belongs to a server endpoint rather than a browser page. */
  owns(pathname: string) {
    // Routes match decoded segments, so `/%61pi/health` belongs to the server as `/api/health`
    // does. A malformed encoding is checked as written.
    const segments = pathSegments(pathname);
    const decoded = segments ? `/${segments.join("/")}` : pathname;
    return serverPrefixes.some(
      (prefix) => decoded.startsWith(prefix) || `${decoded}/` === prefix,
    );
  },
} as const;
