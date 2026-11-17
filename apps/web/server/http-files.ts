import { TRPCError } from "@trpc/server";
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

export { httpError } from "./http-error";
