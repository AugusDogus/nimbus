import { z } from "zod";
import { ClientIp } from "../client-ip";
import { RequestBody } from "../request-body";
import { DevicePairing } from "./device-pairing";
import { ItemKind } from "./item-kind";
import { LibraryAccess, type LibraryScope } from "./library-access";
import { LibraryApiError, noStore } from "./library-api-error";
import type { LibraryContext } from "./library-context";
import { LibraryListing } from "./library-listing";
import { LibraryPosters } from "./library-posters";
import { LibraryThrottle } from "./library-throttle";
import path from "node:path";
import { serveOpened, type BodyWatch } from "../file-response";
import { LibraryCatalog, type OpenedSource } from "./library-catalog";
import type { LibraryThrottleRule } from "./library-throttle";
import { MediaTickets } from "./media-tickets";
import { Transfers } from "./transfers";
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
  /**
   * Check access again, as a transfer does (see deviceWatch), once the answer is worked out:
   * for item `itemId`, or for the whole library when null. Folder grants can be withdrawn while
   * an answer is worked out without the library itself changing.
   */
  watch?: { itemId: string | null };
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
  const watched = options.watch ?? null;
  const watch =
    watched === null
      ? null
      : await deviceWatch(
          ctx,
          authorized.device,
          authorized.scope,
          watched.itemId === null
            ? { kind: "library" }
            : { kind: "item", itemId: watched.itemId },
        );
  let response: Response;
  let refused: string | null = null;
  try {
    response = await respond(authorized.device, authorized.scope);
    if (watch !== null && response.status < 400)
      refused = await watch.allowed();
  } finally {
    watch?.done();
  }
  if (refused !== null) {
    await response.body?.cancel();
    // A whole-library answer is worked out again from the current access, once.
    if (watched?.itemId === null) {
      if (attempt === 0) return asDevice(ctx, request, respond, options, 1);
      return LibraryApiError.response({
        code: "service_unavailable",
        message:
          "Access to this library changed while Nimbus answered. Try again in a moment.",
        retryAfterSeconds: 1,
      });
    }
    response = itemNotFound();
  }
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
 * What a watched answer is about, and so what a full check requires: for the whole library
 * (such as the listing), that nothing changed, since the answer was worked out from the access
 * before; for an item, that the device still reaches it; for a file being sent, that the item
 * still names the file opened for it (`source`, once known), as an id can pass to another file
 * when its own leaves while the descriptor keeps reading the first.
 */
type WatchedAnswer =
  | { kind: "library" }
  | { kind: "item"; itemId: string }
  | { kind: "source"; itemId: string; source: () => OpenedSource | null };

/**
 * What a whole file sent in chunks checks before each chunk. A change this process signals
 * (see Transfers) is seen at the next chunk: a disconnected device stops at once, and a changed
 * library, a change of accounts, groups or grants (the access epoch), or a second gone by makes
 * the chunk check everything the request checked: the device, its library's visible folders and
 * what is watched (`WatchedAnswer`). That last, once a second, also catches changes made by
 * other means. Answers sent with an exact length are only checked before they go out.
 */
async function deviceWatch(
  ctx: LibraryContext,
  device: PairedDevice,
  scope: LibraryScope,
  watched: WatchedAnswer,
): Promise<BodyWatch> {
  const { transfer, end } = Transfers.begin(device.id, scope.library.id);
  let checkedAt = ctx.now();
  let epoch = await ctx.drive.accessEpoch();
  let libraryVersion = scope.library.updatedAt;
  const disconnected =
    "The device was disconnected from Nimbus, so the transfer was stopped.";
  return {
    allowed: async () => {
      if (transfer.stopped !== null) return transfer.stopped;
      const currentEpoch = await ctx.drive.accessEpoch();
      const currentVersion = LibraryAccess.libraryVersion(
        ctx,
        scope.library.id,
      );
      const changed =
        transfer.recheck ||
        currentEpoch !== epoch ||
        currentVersion !== libraryVersion;
      if (
        !changed &&
        (watched.kind === "library" || ctx.now() - checkedAt < 1000)
      )
        return null;
      transfer.recheck = false;
      checkedAt = ctx.now();
      epoch = currentEpoch;
      if (currentVersion === null) return disconnected;
      libraryVersion = currentVersion;
      const still = PairedDevices.byGrant(ctx, device.id);
      if (!still.ok) return disconnected;
      const now = await LibraryAccess.forDevice(ctx, still.device);
      if (!now.ok) return disconnected;
      switch (watched.kind) {
        case "library":
          return "Access to the device's library changed, so the answer was worked out again.";
        case "item":
          return LibraryAccess.resolve(ctx, now.value, watched.itemId).ok
            ? null
            : gone;
        case "source":
          return sameSource(ctx, now.value, watched.itemId, watched.source())
            ? null
            : gone;
      }
    },
    done: end,
  };
}

const gone =
  "This file is no longer in the device's library, so the transfer was stopped.";

/** Whether item `itemId` still reaches `scope` as the file `source` that was opened for it. */
function sameSource(
  ctx: LibraryContext,
  scope: LibraryScope,
  itemId: string,
  source: OpenedSource | null,
) {
  const resolved = LibraryAccess.resolve(ctx, scope, itemId);
  return (
    source !== null &&
    resolved.ok &&
    LibraryCatalog.names(resolved.value, source)
  );
}

const itemEndpoints: Record<string, Endpoint> = {
  item: {
    method: "GET",
    handle: (ctx, request, itemId) =>
      asDevice(
        ctx,
        request,
        async (_device, scope) => {
          const opened = await LibraryAccess.open(ctx, scope, itemId);
          if (!opened.ok) return LibraryApiError.response(opened.error);
          const { item } = opened.value;
          const { stats } = opened.value.opened;
          await opened.value.opened.handle.close();
          const entry = LibraryListing.entry(ctx, scope, {
            ...item,
            version: LibraryCatalog.versionOf(ctx.secret, item.path, stats),
            sizeBytes: stats.size,
          });
          return entry === null ? itemNotFound() : json(entry);
        },
        { watch: { itemId } },
      ),
  },
  file: {
    method: "GET",
    handle: (ctx, request, itemId) =>
      asDevice(
        ctx,
        request,
        async (_device, scope) => {
          // Opened and checked the same way for GET and HEAD, so neither tells more. Sent
          // whole with its exact length once checked; changes apply from the next request.
          const opened = await LibraryAccess.open(ctx, scope, itemId);
          if (!opened.ok) return itemNotFound();
          const served = await serveOpened(request, opened.value.opened, {
            filename: path.posix.basename(opened.value.item.path),
            etag: `"${LibraryCatalog.versionOf(
              ctx.secret,
              opened.value.item.path,
              opened.value.opened.stats,
            )}"`,
            cacheControl: "private, no-cache",
            whole: "exact",
          });
          return served.kind === "served"
            ? served.response
            : LibraryApiError.response({
                code: "service_unavailable",
                message:
                  "This file changed while Nimbus read it. Try again in a moment.",
                retryAfterSeconds: 1,
              });
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
          const version = LibraryCatalog.versionOf(
            ctx.secret,
            opened.value.item.path,
            opened.value.opened.stats,
          );
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
  poster: {
    method: "GET",
    async handle(ctx, request, itemId) {
      const width = LibraryPosters.parseWidth(
        new URL(request.url).searchParams.get("w"),
      );
      if (width === null)
        return invalid(
          "w must be a width in pixels, such as 400, 800 or 1920.",
        );
      return asDevice(
        ctx,
        request,
        async (device, scope) => {
          // Drawing can take a while: access removed meanwhile ends the answer as it ends a
          // transfer, checked once the poster is ready and before it is released.
          let source: OpenedSource | null = null;
          const watch = await deviceWatch(ctx, device, scope, {
            kind: "source",
            itemId,
            source: () => source,
          });
          try {
            const answer = await LibraryPosters.respond(
              ctx,
              request,
              device,
              scope,
              itemId,
              width,
            );
            const { response } = answer;
            source = answer.source;
            // The id may have passed to another file while the first one's poster was drawn.
            if (
              response.status >= 400 ||
              ((await watch.allowed()) === null &&
                sameSource(ctx, scope, itemId, source))
            )
              return response;
            await response.body?.cancel();
            return itemNotFound();
          } finally {
            watch.done();
          }
        },
        { rule: "posterPerDevice" },
      );
    },
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
          const version = LibraryCatalog.versionOf(
            ctx.secret,
            opened.value.item.path,
            stats,
          );
          if (version !== session.version) {
            await handle.close();
            return sourceChanged();
          }
          // A ranged answer goes out whole and cannot be stopped once handed off: a
          // revocation, a library change or a file change takes effect on the next request.
          const served = await serveOpened(request, opened.value.opened, {
            filename: path.posix.basename(opened.value.item.path),
            etag: `"${version}"`,
            cacheControl: "private, no-store",
            watch: await deviceWatch(ctx, device, scope, {
              kind: "source",
              itemId,
              source: () =>
                LibraryCatalog.sourceOf(ctx.secret, opened.value.item, stats),
            }),
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
        : rest === "file" || rest === "stream" || rest === "poster"
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
      return asDevice(
        ctx,
        request,
        async (_device, scope) => {
          const listing = await LibraryListing.library(ctx, scope, kinds);
          if (!listing.ok) return LibraryApiError.response(listing.error);
          return conditional(request, listing.etag, () => json(listing.body));
        },
        { watch: { itemId: null } },
      );
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
