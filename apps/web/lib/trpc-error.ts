import { TRPCClientError } from "@trpc/client";

/** The tRPC error code of `error`, such as `NOT_FOUND`, or undefined for other errors. */
export function trpcErrorCode(error: unknown): string | undefined {
  if (!(error instanceof TRPCClientError)) return undefined;
  const data: unknown = error.data;
  return typeof data === "object" &&
    data !== null &&
    "code" in data &&
    typeof data.code === "string"
    ? data.code
    : undefined;
}
