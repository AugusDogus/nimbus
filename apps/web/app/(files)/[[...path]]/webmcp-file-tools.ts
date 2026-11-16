import type {} from "webmcp-types";
import { trpcClient } from "@/lib/trpc";
import type { EntryDialog } from "./entry-dialogs";
import { FileEntry } from "./types";

/** What the folder view lends its tools; read at call time so tools see the current folder. */
export type FileToolsPage = {
  currentPath: string;
  entries: FileEntry[];
  openFolder: (path: string) => void;
  openDialog: (dialog: EntryDialog) => void;
  createFolder: (name: string) => Promise<void>;
};

type Outcome =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string };

const fail = (error: string): Outcome => ({ ok: false, error });

const stringField = (input: Record<string, unknown>, key: string) => {
  const value = input[key];
  return typeof value === "string" ? value : null;
};

const describe = (entry: FileEntry) => ({
  name: entry.name,
  path: entry.path,
  type: entry.type === "dir" ? "folder" : "file",
  size: entry.type === "dir" ? null : entry.size,
  modifiedAt: entry.mtime === null ? null : new Date(entry.mtime).toISOString(),
  permission: entry.permission,
});

const pathSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Path of an item in the open folder, as list_folder returns it.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

/**
 * Register the folder view's tools. They act through the same client code as
 * the page (the user's session, tRPC procedures, and dialogs), so the server
 * enforces the user's permissions. Rename and move only open their dialogs:
 * the user confirms the change, never the agent alone.
 */
export async function registerFileTools(
  context: WebMCP.ModelContext,
  page: () => FileToolsPage,
  lifetime: AbortSignal,
) {
  const options = { signal: lifetime };
  const entryAt = (input: Record<string, unknown>) => {
    const path = stringField(input, "path");
    return path === null
      ? undefined
      : page().entries.find((entry) => entry.path === path);
  };
  const notInFolder = () =>
    fail(
      "No item with that path is in the open folder. Call nimbus.list_folder for current paths, or open its folder first.",
    );
  const open = (
    action: "preview" | "rename" | "move",
    input: Record<string, unknown>,
    allowed: (entry: FileEntry) => string | null,
  ) => {
    const entry = entryAt(input);
    if (!entry) return notInFolder();
    const refusal = allowed(entry);
    if (refusal !== null) return fail(refusal);
    page().openDialog(
      action === "move" ? { action, entries: [entry] } : { action, entry },
    );
    return null;
  };

  await Promise.all([
    context.registerTool(
      {
        name: "nimbus.list_folder",
        title: "List the open folder",
        description:
          "List the files and folders in the folder open in Nimbus, with your permission on each.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () => {
          const { currentPath, entries } = page();
          return {
            ok: true,
            folder: currentPath,
            entries: entries.map(describe),
          };
        },
      },
      options,
    ),
    context.registerTool(
      {
        name: "nimbus.open_folder",
        title: "Open a folder",
        description: 'Navigate Nimbus to a folder. Use "" for My Drive.',
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                'Folder path relative to the drive root; "" is My Drive.',
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: (input) => {
          const path = stringField(input, "path");
          if (path === null) return fail("Pass the folder path as a string.");
          page().openFolder(path.replace(/^\/+|\/+$/g, ""));
          return { ok: true, opening: path };
        },
      },
      options,
    ),
    context.registerTool(
      {
        name: "nimbus.search",
        title: "Search files",
        description:
          "Find files and folders whose names contain the query, anywhere you have access. Returns up to 50 matches.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Part of a file or folder name",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async (input, { signal }) => {
          const query = stringField(input, "query")?.trim() ?? "";
          if (!query || query.length > 200)
            return fail("Pass a search query of 1 to 200 characters.");
          const result = await trpcClient.catalog.search.query(
            { query, path: "", limit: 50 },
            { signal },
          );
          return {
            ok: true,
            entries: result.entries.slice(0, 50).map(describe),
            truncated: result.truncated || result.entries.length > 50,
          };
        },
      },
      options,
    ),
    context.registerTool(
      {
        name: "nimbus.open_preview",
        title: "Preview a file",
        description:
          "Open a file from the open folder in Nimbus's preview, as if the user clicked it.",
        inputSchema: pathSchema,
        annotations: { readOnlyHint: true },
        execute: (input) =>
          open("preview", input, (entry) =>
            entry.type === "dir"
              ? "That is a folder. Use nimbus.open_folder instead."
              : null,
          ) ?? {
            ok: true,
            previewing: stringField(input, "path"),
          },
      },
      options,
    ),
    context.registerTool(
      {
        name: "nimbus.start_rename",
        title: "Start renaming",
        description:
          "Open the rename dialog for an item in the open folder. The user types the new name and confirms; nothing changes until they do.",
        inputSchema: pathSchema,
        execute: (input) =>
          open("rename", input, (entry) =>
            FileEntry.canMove(entry)
              ? null
              : "Your permission on this item does not allow renaming it.",
          ) ?? {
            ok: true,
            awaitingUser: "The rename dialog is open for the user to confirm.",
          },
      },
      options,
    ),
    context.registerTool(
      {
        name: "nimbus.start_move",
        title: "Start moving",
        description:
          "Open the move dialog for an item in the open folder. The user picks the destination and confirms; nothing changes until they do.",
        inputSchema: pathSchema,
        execute: (input) =>
          open("move", input, (entry) =>
            FileEntry.canMove(entry)
              ? null
              : "Your permission on this item does not allow moving it. Moving a folder needs Admin permission on it.",
          ) ?? {
            ok: true,
            awaitingUser: "The move dialog is open for the user to confirm.",
          },
      },
      options,
    ),
    context.registerTool(
      {
        name: "nimbus.create_folder",
        title: "Create a folder",
        description: "Create a folder inside the open folder.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name of the new folder" },
          },
          required: ["name"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const name = stringField(input, "name")?.trim() ?? "";
          if (!name) return fail("Pass a folder name.");
          const { createFolder, currentPath } = page();
          try {
            await createFolder(name);
          } catch (error) {
            return fail(
              error instanceof Error
                ? error.message
                : "The folder could not be created. Nothing was changed.",
            );
          }
          return {
            ok: true,
            path: currentPath ? `${currentPath}/${name}` : name,
          };
        },
      },
      options,
    ),
  ]);
}
