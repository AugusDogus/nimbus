import { z } from "zod";
import { ClientIp } from "../client-ip";
import { RequestBody } from "../request-body";
import { DevicePairing } from "./device-pairing";
import { ItemKind } from "./item-kind";
import { LibraryAccess, type LibraryScope } from "./library-access";
import { LibraryApiError, noStore } from "./library-api-error";
import type { LibraryContext } from "./library-context";
import { LibraryListing } from "./library-listing";
import { LibraryThrottle } from "./library-throttle";
import path from "node:path";
import { isApiError } from "@nimbus/api/safe-path";
import { serveFile, serveOpened, type BodyWatch } from "../file-response";
import { LibraryCatalog } from "./library-catalog";
import type { LibraryThrottleRule } from "./library-throttle";
import { MediaTickets } from "./media-tickets";
import {
  PairedDevices,
  type DeviceAuth,
  type PairedDevice,
} from "./paired-devices";

/**
 * The library API under /api/library/v1, as docs/library-api/openapi.yaml defines it. Every
 * endpoint but pairing start and poll takes the device's bearer token and reaches files only
 * through `LibraryAccess`. Native clients send no Origin; a page on another site is refused.
 */

/** Request bodies are tiny: the contract caps them at 4 KiB. */
const maxBodyBytes = 4 * 1024;

const startBody = z.strictObject({ deviceName: z.string() });
const pollBody = z.strictObject({ deviceCode: z.string().min(1).max(191) });

const json = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) =>
  Response.json(body, {
    status: init.status ?? 200,
    headers: { ...noStore, ...init.headers },
  });

const invalid = (message: string) =>
  LibraryApiError.response({ code: "invalid_request", message });

/** The request's JSON body, parsed by `schema`, or the 400 explaining what was wrong. */
async function readJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type))
    return {
      ok: false,
      response: invalid(
        "Send the request body as JSON with Content-Type: application/json.",
      ),
    };
  const body = await RequestBody.read(request, maxBodyBytes).catch(() => null);
  if (body === null)
    return {
      ok: false,
      response: invalid("The request body could not be read. Try again."),
    };
  if (body.kind === "too_large")
    return {
      ok: false,
      response: invalid("The request body is larger than 4 KiB. Send less."),
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return {
      ok: false,
      response: invalid("The request body is not valid JSON."),
    };
  }
  const result = schema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : {
        ok: false,
        response: invalid(
          `The request body does not match the library API: ${result.error.issues
            .map(
              (issue) => `${issue.path.join(".") || "body"}: ${issue.message}`,
            )
            .join("; ")}.`,
        ),
      };
}

const address = (request: Request) =>
  ClientIp.bucket(ClientIp.fromHeaders(request.headers));

/**
 * Answer a bearer request with `respond`, given its paired device and library scope, or with
 * the response refusing it. Working out an answer can take a while (a library may be scanned),
 * so the device and its library are checked again, synchronously, just before answering: once
 * a Disconnect, a library change or any other revocation has returned, no answer it ends goes
 * out, also from a request that was already under way. A library changed meanwhile is answered
 * afresh, once. Only a successful answer (a 304 included) counts as use of the device, sliding
 * its 30-day idle deadline.
 */
type DeviceRequest = {
  /** Who is asking: by default the bearer token's device. Checked again before answering. */
  identify?: () => DeviceAuth;
  /** The rate limit the request counts against. */
  rule?: LibraryThrottleRule;
};

async function asDevice(
  ctx: LibraryContext,
  request: Request,
  respond: (device: PairedDevice, scope: LibraryScope) => Promise<Response>,
  options: DeviceRequest = {},
  attempt = 0,
): Promise<Response> {
  const identify =
    options.identify ?? (() => PairedDevices.authenticate(ctx, request));
  const authorized = await authorize(
    ctx,
    identify(),
    options.rule ?? "perDevice",
  );
  if (!authorized.ok) return authorized.response;
  const response = await respond(authorized.device, authorized.scope);
  // Synchronous from here on: nothing can change between this check and the answer.
  const still = identify();
  if (!still.ok || still.device.id !== authorized.device.id) {
    await response.body?.cancel();
    return LibraryApiError.response(
      still.ok
        ? {
            code: "token_revoked",
            message: "This device was disconnected from Nimbus. Pair it again.",
          }
        : still.error,
    );
  }
  if (
    LibraryAccess.libraryVersion(ctx, authorized.scope.library.id) !==
    authorized.scope.library.updatedAt
  ) {
    await response.body?.cancel();
    if (attempt === 0) return asDevice(ctx, request, respond, options, 1);
    return LibraryApiError.response({
      code: "service_unavailable",
      message:
        "This library was changed while Nimbus answered. Try again in a moment.",
      retryAfterSeconds: 1,
    });
  }
  if (response.status < 400) PairedDevices.touch(ctx, authorized.device);
  return response;
}

/** The paired device of a bearer request and its library scope, or the response refusing it. */
async function authorize(
  ctx: LibraryContext,
  auth: DeviceAuth,
  rule: LibraryThrottleRule,
): Promise<
  | { ok: true; device: PairedDevice; scope: LibraryScope }
  | { ok: false; response: Response }
> {
  if (!auth.ok)
    return { ok: false, response: LibraryApiError.response(auth.error) };
  const limit = LibraryThrottle.hit([{ key: auth.device.id, rule }], ctx.now());
  if (!limit.allowed)
    return {
      ok: false,
      response: LibraryApiError.response(
        LibraryApiError.rateLimited(limit.retryAfterSeconds),
      ),
    };
  const scope = await LibraryAccess.forDevice(ctx, auth.device);
  if (!scope.ok)
    return { ok: false, response: LibraryApiError.response(scope.error) };
  return { ok: true, device: auth.device, scope: scope.value };
}

/**
 * `respond()` with `etag` and private revalidation, or 304 when the client already has it. The
 * request was authorized first, so a 304 is an authorized answer too.
 */
function conditional(request: Request, etag: string, respond: () => Response) {
  const headers = { "Cache-Control": "private, no-cache", ETag: etag };
  const ifNoneMatch = request.headers.get("if-none-match");
  if (
    ifNoneMatch !== null &&
    ifNoneMatch
      .split(",")
      .some(
        (tag) => tag.trim().replace(/^W\//, "") === etag || tag.trim() === "*",
      )
  )
    return new Response(null, { status: 304, headers });
  const response = respond();
  for (const [name, value] of Object.entries(headers))
    response.headers.set(name, value);
  return response;
}

type Endpoint = {
  method: "GET" | "POST";
  handle: (
    ctx: LibraryContext,
    request: Request,
    /** The item id, for endpoints under /items/{id} and /media/{id}. */
    itemId: string,
  ) => Promise<Response>;
};

/**
 * The most bytes one ranged media answer carries. Each answer is read whole after every check
 * and sent with its exact length; a player asks for the rest, and each request is checked again.
 */
export const MEDIA_WINDOW_BYTES = 4 * 1024 * 1024;

const itemNotFound = () =>
  LibraryApiError.response({
    code: "item_not_found",
    message:
      "This item is not in the library any more. Reload the library to see what is there.",
  });

const sourceChanged = () =>
  LibraryApiError.response({
    code: "stream_source_changed",
    message:
      "This file changed since its media address was made. Ask for a new address.",
  });

/**
 * What a file body checks between chunks: that this process did not revoke the device, and
 * at most once a second, that the database still has it live, so a revocation by any route ends
 * the body. Bytes already sent cannot be taken back.
 */
function deviceWatch(
  ctx: LibraryContext,
  device: PairedDevice,
  done: () => void,
): BodyWatch {
  let checkedAt = ctx.now();
  const stopped =
    "The device was disconnected from Nimbus, so the transfer was stopped.";
  return {
    allowed: () => {
      if (PairedDevices.revokedHere(device.id)) return stopped;
      if (ctx.now() - checkedAt < 1000) return null;
      checkedAt = ctx.now();
      return PairedDevices.byGrant(ctx, device.id).ok ? null : stopped;
    },
    done,
  };
}

const itemEndpoints: Record<string, Endpoint> = {
  item: {
    method: "GET",
    handle: (ctx, request, itemId) =>
      asDevice(ctx, request, async (_device, scope) => {
        const opened = await LibraryAccess.open(ctx, scope, itemId);
        if (!opened.ok) return LibraryApiError.response(opened.error);
        const { item } = opened.value;
        const { stats } = opened.value.opened;
        await opened.value.opened.handle.close();
        const entry = LibraryListing.entry(scope, {
          ...item,
          version: LibraryCatalog.versionOf(stats),
          sizeBytes: stats.size,
        });
        return entry === null ? itemNotFound() : json(entry);
      }),
  },
  file: {
    method: "GET",
    handle: (ctx, request, itemId) =>
      asDevice(
        ctx,
        request,
        async (_device, scope) => {
          const item = LibraryAccess.resolve(ctx, scope, itemId);
          if (!item.ok) return LibraryApiError.response(item.error);
          // The file response every download uses, through the scope's read-only access.
          try {
            return await serveFile(
              request,
              item.value.path,
              scope.access,
              true,
              () => "fast",
              {
                etag: (stats) => `"${LibraryCatalog.versionOf(stats)}"`,
                cacheControl: "private, no-cache",
              },
            );
          } catch (error) {
            if (
              isApiError(error, "NOT_FOUND") ||
              isApiError(error, "FORBIDDEN") ||
              isApiError(error, "BAD_REQUEST")
            )
              return itemNotFound();
            throw error;
          }
        },
        { rule: "mediaPerDevice" },
      ),
  },
  stream: {
    method: "POST",
    handle: (ctx, request, itemId) =>
      asDevice(
        ctx,
        request,
        async (device, scope) => {
          if (ctx.origin.kind !== "configured")
            return LibraryApiError.response({
              code: "service_unavailable",
              message: ctx.origin.reason,
            });
          const opened = await LibraryAccess.open(ctx, scope, itemId);
          if (!opened.ok) return LibraryApiError.response(opened.error);
          const version = LibraryCatalog.versionOf(opened.value.opened.stats);
          await opened.value.opened.handle.close();
          // Nimbus does not know durations: every address gets the default lifetime.
          const minted = MediaTickets.mint(ctx, device, itemId, version, null);
          return json(
            {
              url: `${ctx.origin.origin}/api/library/v1/media/${encodeURIComponent(itemId)}?ticket=${minted.ticket}`,
              expiresAt: new Date(minted.expiresAt).toISOString(),
            },
            { headers: { "Set-Cookie": minted.setCookie } },
          );
        },
        { rule: "mintPerDevice" },
      ),
  },
  media: {
    method: "GET",
    async handle(ctx, request, itemId) {
      const first = MediaTickets.check(ctx, request, itemId);
      if (!first.ok) return LibraryApiError.response(first.error);
      const { session } = first.grant;
      return asDevice(
        ctx,
        request,
        async (device, scope) => {
          const opened = await LibraryAccess.open(ctx, scope, itemId);
          if (!opened.ok) return itemNotFound();
          const { handle, stats } = opened.value.opened;
          const version = LibraryCatalog.versionOf(stats);
          if (version !== session.version) {
            await handle.close();
            return sourceChanged();
          }
          const release = MediaTickets.claimBody(device.id);
          if (release === null) {
            await handle.close();
            return LibraryApiError.response({
              code: "rate_limited",
              message:
                "This device is already receiving as many files as it may at once. Try again when one finishes.",
              retryAfterSeconds: 1,
            });
          }
          const served = await serveOpened(request, opened.value.opened, {
            filename: path.posix.basename(opened.value.item.path),
            etag: `"${version}"`,
            cacheControl: "private, no-store",
            window: MEDIA_WINDOW_BYTES,
            watch: deviceWatch(ctx, device, release),
          });
          if (served.kind === "served") return served.response;
          if (served.kind === "changed") return sourceChanged();
          return LibraryApiError.response({
            code: "token_revoked",
            message: served.reason,
          });
        },
        {
          rule: "mediaPerDevice",
          identify: () => {
            const checked = MediaTickets.check(ctx, request, itemId);
            return checked.ok
              ? { ok: true, device: checked.grant.device }
              : checked;
          },
        },
      );
    },
  },
};

/** The endpoint at `endpoint`, below /api/library/v1/, with its item id, or null. */
function route(endpoint: string): { found: Endpoint; itemId: string } | null {
  const fixed = Object.hasOwn(endpoints, endpoint)
    ? endpoints[endpoint]
    : undefined;
  if (fixed) return { found: fixed, itemId: "" };
  const [first, itemId, rest, ...more] = endpoint.split("/");
  if (itemId === undefined || itemId === "" || more.length) return null;
  const name =
    first === "items"
      ? rest === undefined
        ? "item"
        : rest === "file" || rest === "stream"
          ? rest
          : null
      : first === "media" && rest === undefined
        ? "media"
        : null;
  const found = name === null ? undefined : itemEndpoints[name];
  return found ? { found, itemId } : null;
}

const endpoints: Record<string, Endpoint> = {
  "pair/start": {
    method: "POST",
    async handle(ctx, request) {
      const body = await readJson(request, startBody);
      if (!body.ok) return body.response;
      const name = DevicePairing.parseDeviceName(body.value.deviceName);
      if (!name.ok) return LibraryApiError.response(name.error);
      const started = DevicePairing.start(ctx, name.value, address(request));
      return started.ok
        ? json(started.value)
        : LibraryApiError.response(started.error);
    },
  },
  "pair/poll": {
    method: "POST",
    async handle(ctx, request) {
      const body = await readJson(request, pollBody);
      if (!body.ok) return body.response;
      const polled = DevicePairing.poll(
        ctx,
        body.value.deviceCode,
        address(request),
      );
      return polled.ok
        ? json(polled.value)
        : LibraryApiError.response(polled.error);
    },
  },
  me: {
    method: "GET",
    async handle(ctx, request) {
      return asDevice(ctx, request, async (device, { library }) =>
        json({
          deviceName: device.name,
          library: { id: library.id, title: library.title },
        }),
      );
    },
  },
  library: {
    method: "GET",
    async handle(ctx, request) {
      const requested = new URL(request.url).searchParams.get("kinds");
      const kinds = requested === null ? null : ItemKind.parseList(requested);
      if (kinds === null && requested !== null)
        return invalid(
          "kinds must be a comma-separated list of video, audio, image, document and other.",
        );
      return asDevice(ctx, request, async (_device, scope) => {
        const listing = await LibraryListing.library(ctx, scope, kinds);
        if (!listing.ok) return LibraryApiError.response(listing.error);
        return conditional(request, listing.etag, () => json(listing.body));
      });
    },
  },
};

/** Whether a browser page on another site sent this request. Native clients send no Origin. */
function foreignPage(ctx: LibraryContext, request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return true;
  const from = request.headers.get("origin");
  return (
    from !== null &&
    (ctx.origin.kind !== "configured" || from !== ctx.origin.origin)
  );
}

export const LibraryHttp = {
  /** Serve `endpoint`, the path below /api/library/v1/. */
  async handle(ctx: LibraryContext, request: Request, endpoint: string) {
    const matched = route(endpoint);
    if (!matched)
      return LibraryApiError.response({
        code: "not_found",
        message: "There is no library API endpoint at this address.",
      });
    const { found, itemId } = matched;
    const method = request.method === "HEAD" ? "GET" : request.method;
    if (method !== found.method)
      return LibraryApiError.response(
        {
          code: "method_not_allowed",
          message: `Use ${found.method} for this endpoint.`,
        },
        { Allow: found.method === "GET" ? "GET, HEAD" : found.method },
      );
    if (foreignPage(ctx, request))
      return LibraryApiError.response({
        code: "forbidden_origin",
        message: "The library API does not answer web pages on other sites.",
      });
    try {
      return await found.handle(ctx, request, itemId);
    } catch (error) {
      // Names only: errors can carry query parameters, token hashes or paths.
      // The endpoint's shape only: item ids are opaque, and query strings may hold credentials.
      console.error(
        `[library-api] ${itemId ? endpoint.replace(itemId, "{id}") : endpoint} failed: ${error instanceof Error ? error.name : typeof error}`,
      );
      return LibraryApiError.response({
        code: "service_unavailable",
        message:
          "Nimbus could not complete this request. Nothing was changed. Try again in a moment.",
        retryAfterSeconds: 5,
      });
    }
  },
} as const;
