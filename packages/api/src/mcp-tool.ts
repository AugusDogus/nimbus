import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getAccess } from "./access";
import type { PreferencesStore } from "./context";
import type { DriveStore } from "./drive-store";
import type { McpScope } from "./mcp-scope";
import { FilesystemFailure } from "./filesystem-failure";
import { createCaller } from "./routers";
import { PathError } from "./safe-path";
import type { UploadDestination } from "./upload-destination";

/**
 * What one authenticated MCP request may act as. Tools call the same tRPC
 * procedures and shared operations as the browser, so the account's file
 * permissions, WebDAV locks, path confinement and disabled-account checks all
 * apply unchanged. Scopes only narrow what this connection may attempt.
 */
export type McpToolContext = {
  userId: string;
  scopes: readonly McpScope[];
  drive: DriveStore;
  preferences: PreferencesStore;
  /** Public origin without a trailing slash, for links returned to the client. */
  origin: string;
  /** A short-lived URL that downloads `path` with this connection's access. */
  downloadLink: (path: string) => Promise<{ url: string; expiresAt: number }>;
  /** A short-lived URL that streams a request body into `destination` with this connection's access. */
  uploadLink: (
    destination: UploadDestination,
  ) => Promise<{ url: string; expiresAt: number }>;
};

export type McpToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

/** Tools only touch this server's drive, so none are open-world. */
export const readOnly: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
export const additive: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
export const idempotentChange: McpToolAnnotations = {
  ...additive,
  idempotentHint: true,
};
export const destructive: McpToolAnnotations = {
  ...additive,
  destructiveHint: true,
};

type Shape = z.ZodRawShape;

/** A tool as written: typed input and output. */
export type McpToolDefinition<I extends Shape, O extends Shape> = {
  name: string;
  title: string;
  description: string;
  scope: McpScope;
  annotations: McpToolAnnotations;
  input: z.ZodObject<I>;
  output: z.ZodObject<O>;
  run: (
    tool: McpToolRun,
    input: z.output<z.ZodObject<I>>,
  ) => Promise<z.input<z.ZodObject<O>>>;
};

/** A tool as served: input arrives unvalidated from the client. */
export type McpTool = {
  name: string;
  title: string;
  description: string;
  scope: McpScope;
  annotations: McpToolAnnotations;
  input: z.ZodObject<Shape>;
  output: z.ZodObject<Shape>;
  call: (context: McpToolContext, input: unknown) => Promise<McpToolResult>;
};

export type McpToolResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

/** Per-call helpers: a tRPC caller acting as the connection's account. */
export type McpToolRun = {
  context: McpToolContext;
  caller: ReturnType<typeof createCaller>;
  access: () => ReturnType<typeof getAccess>;
};

const scopeDenied = (scope: McpScope, context: McpToolContext) =>
  `This tool needs the "${scope}" scope, but this connection was approved with ${
    context.scopes.length ? context.scopes.join(", ") : "no scopes"
  }. Nothing was done. Disconnect the client in Nimbus under Settings, then reconnect it and approve "${scope}".`;

const bareCodeMessages: Record<string, string> = {
  NOT_FOUND:
    "The item or record no longer exists. Nothing was changed. List it again to get current ids.",
  FORBIDDEN:
    "You do not have permission for this. Nothing was changed. Ask the item's owner for access.",
  CONFLICT:
    "This conflicts with the item's current state. Nothing was changed. Check it and retry.",
};

/** Convert expected failures into messages for the agent; keep unexpected ones generic. */
function failureMessage(thrown: unknown, toolName: string): string {
  if (thrown instanceof z.ZodError)
    return `The arguments do not match this tool's input schema: ${z.prettifyError(thrown)} Nothing was changed. Fix the arguments and call ${toolName} again.`;
  // Filesystem errors also have a code and a message, but theirs names host paths.
  const error = FilesystemFailure.toApiError(thrown) ?? thrown;
  const parsed = z
    .object({ code: z.string(), message: z.string() })
    .safeParse(
      error instanceof TRPCError || error instanceof PathError ? error : null,
    );
  if (parsed.success && parsed.data.code !== "INTERNAL_SERVER_ERROR") {
    if (parsed.data.code === "UNAUTHORIZED")
      return "This Nimbus account can no longer be used: it was disabled or removed. Nothing was changed. Ask a Nimbus administrator to restore access.";
    // tRPC uses the code as the message when a procedure gave none.
    return parsed.data.message === parsed.data.code
      ? (bareCodeMessages[parsed.data.code] ??
          `${toolName} was refused (${parsed.data.code}). Nothing was changed.`)
      : parsed.data.message;
  }
  // Names only: messages of unexpected errors can include filesystem paths or query parameters.
  console.error(
    `[mcp] tool ${toolName} failed: ${error instanceof Error ? error.name : typeof error}`,
  );
  return `Nimbus could not complete ${toolName} because of an unexpected server error. The drive may or may not have changed; check the item's current state before retrying. If this continues, ask the administrator to check the Nimbus server logs.`;
}

export function defineTool<I extends Shape, O extends Shape>(
  definition: McpToolDefinition<I, O>,
): McpTool {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    scope: definition.scope,
    annotations: definition.annotations,
    input: definition.input,
    output: definition.output,
    async call(context, raw) {
      if (!context.scopes.includes(definition.scope))
        return { ok: false, message: scopeDenied(definition.scope, context) };
      try {
        const input = definition.input.parse(raw);
        const caller = createCaller({
          headers: new Headers(),
          session: { user: { id: context.userId } },
          // MCP authorizes each request by its token and opens no event streams.
          sessionStillValid: async () => true,
          drive: context.drive,
          preferences: context.preferences,
        });
        const value = definition.output.parse(
          await definition.run(
            {
              context,
              caller,
              access: () => getAccess(context.drive, context.userId),
            },
            input,
          ),
        );
        return { ok: true, value };
      } catch (error) {
        return { ok: false, message: failureMessage(error, definition.name) };
      }
    },
  };
}

/** Raise an expected failure with a message the agent can act on. */
export const toolFailure = (
  code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND" | "FORBIDDEN",
  message: string,
) => new TRPCError({ code, message });

const cursorSchema = z
  .string()
  .regex(/^\d{1,9}$/, "Pass a cursor exactly as a previous call returned it.")
  .optional()
  .describe(
    "Opaque cursor from a previous call's nextCursor. Omit for the first page.",
  );

export const pageInput = (defaultLimit: number, maxLimit: number) => ({
  cursor: cursorSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(maxLimit)
    .default(defaultLimit)
    .describe(`Maximum items to return, at most ${maxLimit}.`),
});

export const pageOutput = {
  nextCursor: z
    .string()
    .nullable()
    .describe(
      "Pass as cursor to get the next page; null when there are no more items.",
    ),
};

export function paginate<T>(
  items: readonly T[],
  page: { cursor?: string; limit: number },
) {
  const start = page.cursor === undefined ? 0 : Number(page.cursor);
  const end = start + page.limit;
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length ? String(end) : null,
  };
}

export const pathInput = z
  .string()
  .max(4096)
  .describe(
    'Path inside the drive, relative to its root, using "/" separators. "" is the drive root.',
  );

export const permissionSchema = z.enum(["read", "write", "admin"]);

export const entryOutput = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "folder"]),
  size: z.number().nullable().describe("Bytes, for files"),
  modifiedAt: z.string().nullable().describe("ISO 8601"),
  permission: permissionSchema.describe("Your access to this item"),
});

export const toEntry = (entry: {
  name: string;
  path: string;
  type: "dir" | "file" | "other";
  size: number | null;
  mtime: number | null;
  permission: "read" | "write" | "admin";
}): z.input<typeof entryOutput> => ({
  name: entry.name,
  path: entry.path,
  type: entry.type === "dir" ? "folder" : "file",
  size: entry.type === "dir" ? null : entry.size,
  modifiedAt: entry.mtime === null ? null : new Date(entry.mtime).toISOString(),
  permission: entry.permission,
});

export const isoTime = (milliseconds: number) =>
  new Date(milliseconds).toISOString();
