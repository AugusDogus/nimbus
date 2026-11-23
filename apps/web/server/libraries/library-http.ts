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
import { PairedDevices, type PairedDevice } from "./paired-devices";

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
 * the response refusing it. Only a successful answer (a 304 included) counts as use of the
 * device, sliding its 30-day idle deadline.
 */
async function asDevice(
  ctx: LibraryContext,
  request: Request,
  respond: (device: PairedDevice, scope: LibraryScope) => Promise<Response>,
): Promise<Response> {
  const authorized = await authorize(ctx, request);
  if (!authorized.ok) return authorized.response;
  const response = await respond(authorized.device, authorized.scope);
  if (response.status < 400) PairedDevices.touch(ctx, authorized.device);
  return response;
}

/** The paired device of a bearer request and its library scope, or the response refusing it. */
async function authorize(
  ctx: LibraryContext,
  request: Request,
): Promise<
  | { ok: true; device: PairedDevice; scope: LibraryScope }
  | { ok: false; response: Response }
> {
  const auth = PairedDevices.authenticate(ctx, request);
  if (!auth.ok)
    return { ok: false, response: LibraryApiError.response(auth.error) };
  const limit = LibraryThrottle.hit(
    [{ key: auth.device.id, rule: "perDevice" }],
    ctx.now(),
  );
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
  handle: (ctx: LibraryContext, request: Request) => Promise<Response>;
};

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
    const found = Object.hasOwn(endpoints, endpoint)
      ? endpoints[endpoint]
      : undefined;
    if (!found)
      return LibraryApiError.response({
        code: "not_found",
        message: "There is no library API endpoint at this address.",
      });
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
      return await found.handle(ctx, request);
    } catch (error) {
      // Names only: errors can carry query parameters, token hashes or paths.
      console.error(
        `[library-api] ${endpoint} failed: ${error instanceof Error ? error.name : typeof error}`,
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
