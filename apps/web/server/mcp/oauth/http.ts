/** Token and registration bodies are tiny; anything larger is refused unread. */
const MAX_BODY_BYTES = 64 * 1024;

export type ProtocolError = {
  status: number;
  error: string;
  description: string;
  headers?: Record<string, string>;
};

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProtocolError };

export const protocolError = (
  status: number,
  error: string,
  description: string,
  headers?: Record<string, string>,
): ProtocolError => ({ status, error, description, headers });

/** Public OAuth endpoints are called cross-origin by browser-based clients, without credentials. */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers":
    "WWW-Authenticate, Retry-After, Mcp-Session-Id",
};

export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return Response.json(body, {
    status: init.status ?? 200,
    headers: { "Cache-Control": "no-store", ...corsHeaders, ...init.headers },
  });
}

export const errorResponse = (error: ProtocolError) =>
  json(
    { error: error.error, error_description: error.description },
    { status: error.status, headers: error.headers },
  );

export const preflight = (methods: string) =>
  new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders,
      "Access-Control-Allow-Methods": `${methods}, OPTIONS`,
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
      "Access-Control-Max-Age": "86400",
    },
  });

async function readBody(request: Request): Promise<Parsed<string>> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES)
    return {
      ok: false,
      error: protocolError(
        413,
        "invalid_request",
        "The request body is too large.",
      ),
    };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return {
      ok: false,
      error: protocolError(
        400,
        "invalid_request",
        "The request body could not be read.",
      ),
    };
  }
  if (Buffer.byteLength(text) > MAX_BODY_BYTES)
    return {
      ok: false,
      error: protocolError(
        413,
        "invalid_request",
        "The request body is too large.",
      ),
    };
  return { ok: true, value: text };
}

const mediaType = (request: Request) =>
  (request.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase() ?? "";

/** application/x-www-form-urlencoded with no repeated parameters (RFC 6749 section 3.1). */
export async function readForm(
  request: Request,
): Promise<Parsed<ReadonlyMap<string, string>>> {
  if (mediaType(request) !== "application/x-www-form-urlencoded")
    return {
      ok: false,
      error: protocolError(
        400,
        "invalid_request",
        "Send the request as application/x-www-form-urlencoded.",
      ),
    };
  const body = await readBody(request);
  if (!body.ok) return body;
  const form = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(body.value)) {
    if (form.has(key))
      return {
        ok: false,
        error: protocolError(
          400,
          "invalid_request",
          `The "${key}" parameter must not be repeated.`,
        ),
      };
    if (value !== "") form.set(key, value);
  }
  return { ok: true, value: form };
}

export async function readJsonObject(
  request: Request,
): Promise<Parsed<Record<string, unknown>>> {
  if (mediaType(request) !== "application/json")
    return {
      ok: false,
      error: protocolError(
        400,
        "invalid_client_metadata",
        "Send the registration as application/json.",
      ),
    };
  const body = await readBody(request);
  if (!body.ok) return body;
  let value: unknown;
  try {
    value = JSON.parse(body.value);
  } catch {
    return {
      ok: false,
      error: protocolError(
        400,
        "invalid_client_metadata",
        "The request body is not valid JSON.",
      ),
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {
      ok: false,
      error: protocolError(
        400,
        "invalid_client_metadata",
        "The request body must be a JSON object.",
      ),
    };
  return { ok: true, value: Object.fromEntries(Object.entries(value)) };
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * A standalone page for authorization errors that must not redirect to an
 * unverified client. Colors are Nimbus's default palette tokens; the login page uses bg-muted behind a card.
 */
export const htmlError = (status: number, title: string, message: string) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · Nimbus</title><style>
:root{color-scheme:light dark;--bg:#eceef2;--card:#fff;--fg:#242731;--muted:#626876;--border:#dce0e7}
@media (prefers-color-scheme:dark){:root{--bg:#2a2c32;--card:#2a2c31;--fg:#e8e9ed;--muted:#a0a3ad;--border:#363940}}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,sans-serif;padding:24px;box-sizing:border-box}
main{width:100%;max-width:24rem;background:var(--card);border:1px solid var(--border);border-radius:1rem;padding:1.5rem;box-sizing:border-box}
h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem;text-wrap:balance}p{margin:0;color:var(--muted);text-wrap:pretty}
</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );

export const seeOther = (location: string) =>
  new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
