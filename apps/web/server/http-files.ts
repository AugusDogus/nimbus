import { TRPCError } from "@trpc/server";
import { getAccess } from "@nimbus/api/access";
import { FileLockedError } from "@nimbus/api/file-mutations";

import { auth } from "@/lib/auth";
import { db } from "./db";
import { createDriveStore } from "./drive-store";

export const httpDriveStore = createDriveStore(db);

export async function requestAccess(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sign in to access your drive.",
    });
  return getAccess(httpDriveStore, session.user.id);
}

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
};

export function httpError(error: unknown) {
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
