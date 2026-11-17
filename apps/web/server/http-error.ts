import { TRPCError } from "@trpc/server";
import { FileLockedError } from "@nimbus/api/file-mutations";
import { FilesystemFailure } from "@nimbus/api/filesystem-failure";

/** HTTP statuses of the tRPC error codes file routes raise; any other error is a 500. */
const errorStatuses: Partial<Record<TRPCError["code"], number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_REQUEST: 400,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  SERVICE_UNAVAILABLE: 503,
};

/**
 * The response for a failed file route. Nimbus's own refusals keep their message; expected
 * filesystem failures get the plain message of `FilesystemFailure`, with the original, which
 * names host paths, logged here only; anything else is a logged, generic 500.
 */
export function httpError(thrown: unknown) {
  const mapped = FilesystemFailure.toApiError(thrown);
  if (mapped)
    console.warn(`Nimbus file request failed: ${mapped.message}`, thrown);
  const error = mapped ?? thrown;
  const status =
    error instanceof FileLockedError
      ? 423
      : error instanceof TRPCError
        ? errorStatuses[error.code]
        : undefined;
  if (error instanceof TRPCError && status !== undefined)
    return Response.json({ error: error.message }, { status });
  console.error("Nimbus file request failed", error);
  return Response.json(
    {
      error:
        "The file operation failed. Refresh the drive to check its state, then try again. Check server logs if the problem continues.",
    },
    { status: 500 },
  );
}
