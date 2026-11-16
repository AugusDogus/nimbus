import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getAccess } from "@nimbus/api/access";

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

const requestError = z.object({
  code: z.enum([
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "TOO_MANY_REQUESTS",
    "INTERNAL_SERVER_ERROR",
    "BAD_REQUEST",
    "PRECONDITION_FAILED",
    "PAYLOAD_TOO_LARGE",
  ]),
  message: z.string(),
  name: z.string().optional(),
});
const errorStatuses = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_REQUEST: 400,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
} as const;

export function httpError(error: unknown) {
  // The custom server and Next's bundles can load separate copies of tRPC.
  const parsed = requestError.safeParse(error);
  if (parsed.success) {
    const status =
      parsed.data.name === "FileLockedError"
        ? 423
        : errorStatuses[parsed.data.code];
    return Response.json({ error: parsed.data.message }, { status });
  }
  console.error("Nimbus file request failed", error);
  return Response.json(
    {
      error:
        "The file operation failed. Refresh the drive to check its state, then try again. Check server logs if the problem continues.",
    },
    { status: 500 },
  );
}
