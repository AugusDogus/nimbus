import { z } from "zod";
import { httpError } from "./http-files";

const tusFailureSchema = z.object({
  status_code: z.number().int().min(400).max(599),
  body: z.string(),
});

/** Convert a thrown error into the `{ status_code, body }` shape tus hooks reply with. */
export function tusFailure(error: unknown) {
  const failure = tusFailureSchema.safeParse(error);
  if (failure.success) return failure.data;
  const response = httpError(error);
  return {
    status_code: response.status,
    body:
      error instanceof Error ? error.message : "The upload failed. Try again.",
  };
}
