/**
 * Failures of the library API, as `{ error: { code, message } }` with a stable code a client
 * branches on and a message a person can act on. Messages never name paths or credentials.
 */
export type LibraryApiErrorCode =
  | "invalid_request"
  | "authorization_required"
  | "token_invalid"
  | "token_revoked"
  | "library_unavailable"
  | "library_too_large"
  | "item_not_found"
  | "not_found"
  | "method_not_allowed"
  | "forbidden_origin"
  | "rate_limited"
  | "slow_down"
  | "service_unavailable";

export type LibraryApiError = {
  code: LibraryApiErrorCode;
  message: string;
  /** Seconds to wait before trying again, sent as Retry-After. */
  retryAfterSeconds?: number;
  /** `slow_down` only: the least poll interval from now on. */
  interval?: number;
};

const statuses: Record<LibraryApiErrorCode, number> = {
  invalid_request: 400,
  authorization_required: 401,
  token_invalid: 401,
  token_revoked: 401,
  forbidden_origin: 403,
  item_not_found: 404,
  not_found: 404,
  method_not_allowed: 405,
  library_too_large: 422,
  rate_limited: 429,
  slow_down: 429,
  library_unavailable: 503,
  service_unavailable: 503,
};

/** Every library API response: private, never stored by the client's or any proxy's cache. */
export const noStore = { "Cache-Control": "private, no-store" } as const;

export const LibraryApiError = {
  status: (code: LibraryApiErrorCode) => statuses[code],
  response(error: LibraryApiError, headers: Record<string, string> = {}) {
    const all: Record<string, string> = {
      ...noStore,
      ...headers,
      ...(error.retryAfterSeconds !== undefined && {
        "Retry-After": String(error.retryAfterSeconds),
      }),
      ...(statuses[error.code] === 401 && {
        "WWW-Authenticate":
          error.code === "authorization_required"
            ? 'Bearer realm="nimbus-library"'
            : 'Bearer realm="nimbus-library", error="invalid_token"',
      }),
    };
    return Response.json(
      {
        error: { code: error.code, message: error.message },
        ...(error.interval !== undefined && { interval: error.interval }),
      },
      { status: statuses[error.code], headers: all },
    );
  },
  rateLimited: (retryAfterSeconds: number): LibraryApiError => ({
    code: "rate_limited",
    message: `Too many requests from this device or network. Wait ${retryAfterSeconds} seconds and try again. Nothing was changed.`,
    retryAfterSeconds,
  }),
} as const;
