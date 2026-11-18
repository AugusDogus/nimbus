import { z } from "zod";
import { fileTag } from "./file-content";
import type { FileEntry } from "./file-browser";

/**
 * What an MCP upload link may write: one file, or any files beneath one folder, and what
 * happens when a name is taken. Replacing only the version that was read (`match`) needs one
 * known file, so folder links cannot carry it.
 */
const ruleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refuse") }),
  z.object({ kind: z.literal("overwrite") }),
  z.object({ kind: z.literal("keep-both") }),
]);

const schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: z.string(),
    rule: z.union([
      ruleSchema,
      z.object({ kind: z.literal("match"), etag: z.string().max(100) }),
    ]),
  }),
  z.object({ kind: z.literal("folder"), path: z.string(), rule: ruleSchema }),
]);

export type UploadDestination = z.infer<typeof schema>;
export type UploadRule = UploadDestination["rule"];

/** Whether a write under `rule` may land on `current`, the entry there now, or null when none. */
const accepts = (rule: UploadRule, current: FileEntry | null) => {
  switch (rule.kind) {
    case "match":
      return current !== null && fileTag(current) === rule.etag;
    case "overwrite":
      return true;
    case "refuse":
    case "keep-both":
      return current === null;
  }
};

export const UploadDestination = { schema, accepts } as const;
