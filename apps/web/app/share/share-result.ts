import { queryOptions } from "@tanstack/react-query";
import * as z from "zod/mini";

const entrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "dir"]),
  size: z.number(),
  mtime: z.number(),
});
const openSchema = z.object({
  entry: entrySchema,
  entries: z.array(entrySchema),
  expiresAt: z.nullable(z.number()),
  mode: z.enum(["download", "view"]),
});
const errorSchema = z.object({ error: z.string() });

/**
 * What a public link shows: its listing, a password form, or why it is unavailable. The page
 * and the server that renders it read the same share endpoint and turn its answer into this.
 */
export type ShareResult =
  | ({ kind: "open" } & z.infer<typeof openSchema>)
  | { kind: "locked" }
  | { kind: "unavailable"; message: string };

const resultSchema = z.union([
  z.extend(openSchema, { kind: z.literal("open") }),
  z.object({ kind: z.literal("locked") }),
  z.object({ kind: z.literal("unavailable"), message: z.string() }),
]);

export const ShareResult = {
  /** The share endpoint's answer, from its status and JSON body. */
  fromResponse(status: number, data: unknown): ShareResult {
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
          : "This share could not be loaded.",
      };
    }
    return { kind: "open", ...openSchema.parse(data) };
  },
  /** A result sent with the page, or undefined when it is malformed. */
  parse(value: unknown): ShareResult | undefined {
    const parsed = resultSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  },
} as const;

/** The share endpoint for `token`, listing the folder `path` inside it. */
export const shareEndpoint = (token: string) =>
  `/api/share/${encodeURIComponent(token)}`;
export const shareUrl = (token: string, path: string) =>
  `${shareEndpoint(token)}?path=${encodeURIComponent(path)}`;

export const publicShareQuery = (token: string, path: string) =>
  queryOptions({
    queryKey: ["public-share", token, path],
    retry: false,
    queryFn: async () => {
      const response = await fetch(shareUrl(token, path));
      return ShareResult.fromResponse(response.status, await response.json());
    },
  });
