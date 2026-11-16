import { queryOptions } from "@tanstack/react-query";
import * as z from "zod/mini";

const detailsSchema = z.object({
  folder: z.string(),
  note: z.nullable(z.string()),
  expiresAt: z.nullable(z.number()),
  maxFileBytes: z.number(),
  remainingFiles: z.nullable(z.number()),
});
const errorSchema = z.object({ error: z.string() });

/**
 * What an upload link shows: where files go and the limits, a password form, or why it is
 * unavailable. The page and the server that renders it read the same endpoint.
 */
export type FileRequestResult =
  | ({ kind: "open" } & z.infer<typeof detailsSchema>)
  | { kind: "locked" }
  | { kind: "unavailable"; message: string };

const resultSchema = z.union([
  z.extend(detailsSchema, { kind: z.literal("open") }),
  z.object({ kind: z.literal("locked") }),
  z.object({ kind: z.literal("unavailable"), message: z.string() }),
]);

export const FileRequestResult = {
  /** The details endpoint's answer, from its status and JSON body. */
  fromResponse(status: number, data: unknown): FileRequestResult {
    if (
      status === 401 &&
      typeof data === "object" &&
      data !== null &&
      "passwordRequired" in data
    )
      return { kind: "locked" };
    if (status < 200 || status > 299) {
      const error = errorSchema.safeParse(data);
      return {
        kind: "unavailable",
        message: error.success
          ? error.data.error
          : "This upload link could not be loaded.",
      };
    }
    return { kind: "open", ...detailsSchema.parse(data) };
  },
  /** A result sent with the page, or undefined when it is malformed. */
  parse(value: unknown): FileRequestResult | undefined {
    const parsed = resultSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  },
} as const;

export const fileRequestEndpoint = (token: string) =>
  `/api/file-request/${encodeURIComponent(token)}`;

export const fileRequestQuery = (token: string) =>
  queryOptions({
    queryKey: ["file-request", token],
    retry: false,
    queryFn: async () => {
      const response = await fetch(fileRequestEndpoint(token));
      return FileRequestResult.fromResponse(
        response.status,
        await response.json(),
      );
    },
  });
