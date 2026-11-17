import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { httpError } from "./http-error";

const tusFailureSchema = z.object({
  status_code: z.number().int().min(400).max(599),
  body: z.string(),
});

/**
 * Convert a thrown error into the `{ status_code, body }` shape tus hooks reply with. Only
 * failures Nimbus raised on purpose keep their message; anything else (a filesystem error,
 * which names host paths) is logged by `httpError` and answered generically, since file
 * request uploaders are anonymous.
 */
export function tusFailure(error: unknown) {
  const failure = tusFailureSchema.safeParse(error);
  if (failure.success) return failure.data;
  const response = httpError(error);
  return {
    status_code: response.status,
    body:
      error instanceof TRPCError && response.status < 500
        ? error.message
        : "The upload failed on the server. The file was not saved. Try again; if it keeps failing, ask the server's administrator to check its logs.",
  };
}
