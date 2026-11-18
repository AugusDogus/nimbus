import path from "node:path";
import { z } from "zod";
import { permissionFor } from "./access";
import { entryAt } from "./file-browser";
import {
  commitStagedFile,
  fileTag,
  readFileText,
  stageFile,
} from "./file-content";
import { safePath } from "./file-operations";
import { fileNameSchema } from "./file-name";
import { McpScope } from "./mcp-scope";
import {
  additive,
  defineTool,
  destructive,
  entryOutput,
  idempotentChange,
  isoTime,
  pageInput,
  pageOutput,
  paginate,
  pathInput,
  readOnly,
  toEntry,
  toolFailure,
} from "./mcp-tool";
import { FileListing } from "./file-listing";
import { isApiError } from "./safe-path";
import { UploadDestination } from "./upload-destination";

export const MAX_TEXT_READ_BYTES = 256 * 1024;
export const MAX_TEXT_WRITE_BYTES = 4 * 1024 * 1024;

const byFolderThenName = (
  a: { type: string; name: string },
  b: { type: string; name: string },
) =>
  a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1;

const listFolder = defineTool({
  name: "list_folder",
  title: "List folder",
  description:
    'List the files and folders inside a folder, folders first. Use "" for the drive root. Returns pages; pass nextCursor to continue.',
  scope: McpScope.read,
  annotations: readOnly,
  input: z.object({ path: pathInput.default(""), ...pageInput(100, 500) }),
  output: z.object({
    path: z.string(),
    entries: z.array(entryOutput),
    ...pageOutput,
  }),
  async run({ caller }, input) {
    const target = await safePath(input.path);
    const entries = FileListing.entries(
      await caller.files.list({ path: target.relative, includeStats: true }),
    );
    const page = paginate([...entries].sort(byFolderThenName), input);
    return {
      path: target.relative,
      entries: page.items.map(toEntry),
      nextCursor: page.nextCursor,
    };
  },
});

const stat = defineTool({
  name: "get_item",
  title: "Get item details",
  description:
    "Get one file or folder's size, modification time, version tag (etag), and what you may do with it.",
  scope: McpScope.read,
  annotations: readOnly,
  input: z.object({ path: pathInput }),
  output: entryOutput.extend({
    etag: z
      .string()
      .nullable()
      .describe("Version tag of a file; pass to write_text as expectedEtag"),
    canWrite: z.boolean(),
    canShare: z.boolean(),
  }),
  async run({ access, caller }, input) {
    const target = await safePath(input.path);
    const current = await access();
    if (!current.canBrowse(target.relative))
      throw toolFailure(
        "FORBIDDEN",
        "You do not have access to this item. Ask its owner to share it with you.",
      );
    const entry = await entryAt(target.relative);
    const capabilities = await caller.access.capabilities({
      path: target.relative,
    });
    return {
      ...toEntry({ ...entry, permission: permissionFor(current, entry.path) }),
      etag: entry.type === "file" ? fileTag(entry) : null,
      canWrite: capabilities.canWrite,
      canShare: capabilities.canShare,
    };
  },
});

const search = defineTool({
  name: "search_files",
  title: "Search files",
  description:
    "Find files and folders by name under a folder you can read, using Nimbus's filename index (case-insensitive). Names containing the whole query come first; then items whose name holds some of its words and whose folders hold the rest, so `2024 invoice` finds Finance/2024/invoice-0042.pdf. total counts every match; page through all of them with nextCursor. complete is false while the index is still being built after the server started, so some matches may be missing.",
  scope: McpScope.read,
  annotations: readOnly,
  input: z.object({
    query: z.string().trim().min(1).max(200),
    path: pathInput
      .default("")
      .describe("Folder to search under. Defaults to the whole drive."),
    ...pageInput(50, 200),
    cursor: z
      .string()
      .regex(
        /^[\w-]{1,200}$/,
        "Pass a cursor exactly as a previous call returned it.",
      )
      .optional()
      .describe(
        "Opaque cursor from a previous call's nextCursor. Omit for the first page.",
      ),
  }),
  output: z.object({
    entries: z.array(entryOutput),
    total: z.number(),
    restarted: z
      .boolean()
      .describe(
        "True when the previous page could not be continued (the drive changed a lot, your recent opens changed, or the cursor is from before a restart): this is the first page again, so replace the entries you have with it and page on from its nextCursor. No match is skipped either way.",
      ),
    truncated: z.boolean(),
    complete: z.boolean(),
    ...pageOutput,
  }),
  async run({ caller }, input) {
    const result = await caller.catalog.search({
      query: input.query,
      path: input.path,
      limit: input.limit,
      depth: "full",
      cursor: input.cursor,
    });
    return {
      entries: result.entries.map(toEntry),
      total: result.total,
      restarted: result.restarted,
      truncated: result.truncated,
      complete: result.complete,
      nextCursor: result.next,
    };
  },
});

const readText = defineTool({
  name: "read_text",
  title: "Read text file",
  description: `Read a UTF-8 text file in byte ranges of at most ${MAX_TEXT_READ_BYTES / 1024} KiB. Continue from nextOffset until it is null. Binary files are reported, not decoded; use get_download_link for them.`,
  scope: McpScope.read,
  annotations: readOnly,
  input: z.object({
    path: pathInput,
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Byte offset: 0, or a nextOffset from a previous read"),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_TEXT_READ_BYTES)
      .default(64 * 1024),
  }),
  output: z.object({
    path: z.string(),
    size: z.number().describe("Total file size in bytes"),
    etag: z.string(),
    content: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        text: z.string(),
        offset: z.number(),
        nextOffset: z.number().nullable(),
      }),
      z.object({ kind: z.literal("binary"), hint: z.string() }),
    ]),
  }),
  async run({ access }, input) {
    const read = await readFileText(await access(), input.path, {
      offset: input.offset,
      maxBytes: input.maxBytes,
    });
    return {
      path: read.path,
      size: read.size,
      etag: read.etag,
      content:
        read.kind === "text"
          ? {
              kind: "text" as const,
              text: read.content,
              offset: read.offset,
              nextOffset: read.nextOffset,
            }
          : {
              kind: "binary" as const,
              hint: "This file is not UTF-8 text. Use get_download_link to fetch its bytes.",
            },
    };
  },
});

const downloadLink = defineTool({
  name: "get_download_link",
  title: "Get download link",
  description:
    "Create a short-lived URL that downloads a file, or a folder as a ZIP archive, with your access. It stops working after expiresAt, if this connection is revoked, or if your access changes.",
  scope: McpScope.read,
  annotations: readOnly,
  input: z.object({ path: pathInput }),
  output: z.object({
    url: z.string(),
    expiresAt: z.string(),
    type: z.enum(["file", "folder"]),
  }),
  async run({ access, context }, input) {
    const target = await safePath(input.path);
    (await access()).require(target.relative, "read");
    const entry = await entryAt(target.relative);
    const link = await context.downloadLink(target.relative);
    return {
      url: link.url,
      expiresAt: isoTime(link.expiresAt),
      type: entry.type === "dir" ? ("folder" as const) : ("file" as const),
    };
  },
});

/** The entry at `relative`, or null when nothing is there. */
async function entryOrNull(relative: string) {
  try {
    return await entryAt(relative);
  } catch (error) {
    if (isApiError(error, "NOT_FOUND")) return null;
    throw error;
  }
}

const uploadLink = defineTool({
  name: "get_upload_link",
  title: "Get upload link",
  description:
    'Create a short-lived URL to upload a file of any size or type by HTTP PUT of its raw bytes, such as with curl -T; never put file bytes in tool arguments. With folder: true, PUT each file to url/<relative path> beneath that folder; missing subfolders are created. Like write_text, it refuses to replace a file unless you pass expectedEtag or onConflict "overwrite"; "keep-both" numbers the new name instead. Start each upload before expiresAt; one in progress may finish. Each path uploads once per link.',
  scope: McpScope.write,
  annotations: { ...additive, destructiveHint: true },
  input: z.object({
    path: pathInput.describe(
      "File path, including its name; with folder: true, an existing folder.",
    ),
    folder: z.boolean().default(false),
    onConflict: z.enum(["refuse", "overwrite", "keep-both"]).default("refuse"),
    expectedEtag: z
      .string()
      .max(100)
      .optional()
      .describe("Replace only this version of the file, from get_item"),
  }),
  output: z.object({
    url: z.string(),
    method: z.literal("PUT"),
    headers: z
      .record(z.string(), z.string())
      .describe("Headers to send; none are required"),
    expiresAt: z.string(),
    curl: z.string().describe("A ready-to-run example"),
  }),
  async run({ access, context }, input) {
    if (
      input.expectedEtag !== undefined &&
      (input.folder || input.onConflict !== "refuse")
    )
      throw toolFailure(
        "BAD_REQUEST",
        "expectedEtag names one version of one file, so it cannot be combined with folder: true or onConflict. Nothing was created. Pass only one of them.",
      );
    const target = await safePath(input.path);
    (await access()).require(target.relative, "write");
    const current = await entryOrNull(target.relative);
    if (input.folder) {
      if (current?.type !== "dir")
        throw toolFailure(
          "NOT_FOUND",
          `${target.relative || "The drive root"} is not a folder. No link was created. Create it with create_folder, or pass a file path without folder: true.`,
        );
      const link = await context.uploadLink({
        kind: "folder",
        path: target.relative,
        rule: { kind: input.onConflict },
      });
      return {
        url: link.url,
        method: "PUT" as const,
        headers: {},
        expiresAt: isoTime(link.expiresAt),
        curl: `cd ./local-folder && find . -type f | while IFS= read -r f; do f="\${f#./}"; curl -sS --fail-with-body --variable "p=$f" --expand-url "${link.url}/{{p:url}}" -T "$f" || break; done`,
      };
    }
    const name = fileNameSchema.safeParse(
      target.relative.split("/").pop() ?? "",
    );
    if (!name.success)
      throw toolFailure(
        "BAD_REQUEST",
        "Choose a file name without control characters. The name .nimbus is reserved. No link was created.",
      );
    if (current?.type === "dir")
      throw toolFailure(
        "CONFLICT",
        `${target.relative} is a folder. No link was created. Choose a file path inside it, or pass folder: true.`,
      );
    const rule =
      input.expectedEtag !== undefined
        ? { kind: "match" as const, etag: input.expectedEtag }
        : { kind: input.onConflict };
    if (
      current !== null &&
      rule.kind !== "keep-both" &&
      !UploadDestination.accepts(rule, current)
    )
      throw toolFailure(
        "CONFLICT",
        rule.kind === "match"
          ? `${target.relative} changed since you read it (its etag is now ${fileTag(current)}). No link was created. Read it again, then retry with the new etag.`
          : `${target.relative} already exists. No link was created. Pass its etag as expectedEtag to replace it, onConflict "overwrite", or onConflict "keep-both".`,
      );
    if (current === null && rule.kind === "match")
      throw toolFailure(
        "CONFLICT",
        `No file exists at ${target.relative}, so it does not match expectedEtag. No link was created. Omit expectedEtag to create it.`,
      );
    const parent = path.posix.dirname(target.relative);
    if ((await entryOrNull(parent === "." ? "" : parent))?.type !== "dir")
      throw toolFailure(
        "NOT_FOUND",
        "The parent folder does not exist. No link was created. Create it with create_folder first.",
      );
    const link = await context.uploadLink({
      kind: "file",
      path: target.relative,
      rule,
    });
    return {
      url: link.url,
      method: "PUT" as const,
      headers: {},
      expiresAt: isoTime(link.expiresAt),
      curl: `curl -sS --fail-with-body -T ./local-file "${link.url}"`,
    };
  },
});

const sharedWithMe = defineTool({
  name: "list_shared_with_me",
  title: "List items shared with me",
  description:
    "List the files and folders other people have shared with your account, with your permission on each.",
  scope: McpScope.read,
  annotations: readOnly,
  input: z.object(pageInput(100, 500)),
  output: z.object({ entries: z.array(entryOutput), ...pageOutput }),
  async run({ caller }, input) {
    const page = paginate(await caller.catalog.shared(), input);
    return { entries: page.items.map(toEntry), nextCursor: page.nextCursor };
  },
});

const trashOutput = z.object({
  id: z.string().describe("Pass to restore_from_trash"),
  path: z.string().describe("Original location"),
  deletedAt: z.string(),
  expiresAt: z
    .string()
    .describe("Nimbus permanently deletes the item after this time"),
});
const toTrash = (item: {
  id: string;
  path: string;
  deletedAt: number;
  expiresAt: number;
}) => ({
  id: item.id,
  path: item.path,
  deletedAt: isoTime(item.deletedAt),
  expiresAt: isoTime(item.expiresAt),
});

const listTrash = defineTool({
  name: "list_trash",
  title: "List trash",
  description:
    "List items you moved to trash, newest first. Items stay for 30 days and can be restored with restore_from_trash.",
  scope: McpScope.read,
  annotations: readOnly,
  input: z.object(pageInput(100, 500)),
  output: z.object({ items: z.array(trashOutput), ...pageOutput }),
  async run({ caller }, input) {
    const items = [...(await caller.trash.list())].sort(
      (a, b) => b.deletedAt - a.deletedAt,
    );
    const page = paginate(items, input);
    return { items: page.items.map(toTrash), nextCursor: page.nextCursor };
  },
});

const writeText = defineTool({
  name: "write_text",
  title: "Write text file",
  description: `Create a UTF-8 text file, or replace one, with up to ${MAX_TEXT_WRITE_BYTES / 1024 / 1024} MiB of content; for binary or larger files use get_upload_link. By default it refuses to replace an existing file. To replace one safely, pass the etag from get_item or read_text as expectedEtag; the write is refused if the file changed since. overwrite: true replaces whatever is there.`,
  scope: McpScope.write,
  annotations: { ...additive, destructiveHint: true },
  input: z.object({
    path: pathInput.describe(
      "File path, including its name. The parent folder must exist.",
    ),
    content: z.string(),
    expectedEtag: z.string().max(100).optional(),
    overwrite: z.boolean().default(false),
  }),
  output: z.object({
    outcome: z.enum(["created", "replaced"]),
    entry: entryOutput,
    etag: z.string(),
  }),
  async run({ access, context }, input) {
    if (Buffer.byteLength(input.content) > MAX_TEXT_WRITE_BYTES)
      throw toolFailure(
        "BAD_REQUEST",
        `The content is larger than ${MAX_TEXT_WRITE_BYTES / 1024 / 1024} MiB. Nothing was written. Upload it with get_upload_link instead.`,
      );
    const target = await safePath(input.path);
    const name = fileNameSchema.safeParse(
      target.relative.split("/").pop() ?? "",
    );
    if (!name.success)
      throw toolFailure(
        "BAD_REQUEST",
        "Choose a file name without control characters. The name .nimbus is reserved. Nothing was written.",
      );
    // Checked again inside the commit lock; this avoids staging content that cannot be written.
    (await access()).require(target.relative, "write");
    const staged = await stageFile(input.content);
    try {
      const outcome = await commitStagedFile(
        {
          userId: context.userId,
          authorize: access,
          drive: context.drive,
        },
        target.relative,
        staged,
        (current) =>
          input.expectedEtag !== undefined
            ? current !== null && fileTag(current) === input.expectedEtag
            : input.overwrite || current === null,
      );
      switch (outcome.kind) {
        case "created":
        case "replaced": {
          const current = await access();
          return {
            outcome: outcome.kind,
            entry: toEntry({
              ...outcome.entry,
              permission: permissionFor(current, outcome.entry.path),
            }),
            etag: fileTag(outcome.entry),
          };
        }
        case "precondition_failed":
          throw toolFailure(
            "CONFLICT",
            outcome.current === null
              ? `No file exists at ${target.relative}, so it does not match expectedEtag. Nothing was written. Omit expectedEtag to create it.`
              : input.expectedEtag !== undefined
                ? `${target.relative} changed since you read it (its etag is now ${fileTag(outcome.current)}). Nothing was written. Read it again, then retry with the new etag.`
                : `${target.relative} already exists. Nothing was written. Pass its etag as expectedEtag to replace it, or overwrite: true.`,
          );
        case "is_directory":
          throw toolFailure(
            "CONFLICT",
            `${target.relative} is a folder. Nothing was written. Choose a file path inside it.`,
          );
        case "missing_parent":
          throw toolFailure(
            "NOT_FOUND",
            "The parent folder does not exist. Nothing was written. Create it with create_folder first.",
          );
      }
    } finally {
      await staged.discard();
    }
  },
});

const createFolder = defineTool({
  name: "create_folder",
  title: "Create folder",
  description: "Create a folder inside an existing folder.",
  scope: McpScope.write,
  annotations: additive,
  input: z.object({
    parentPath: pathInput.default(""),
    name: z.string().max(255),
  }),
  output: z.object({ path: z.string() }),
  async run({ caller }, input) {
    return {
      path: (
        await caller.files.createFolder({
          path: input.parentPath,
          name: input.name,
        })
      ).path,
    };
  },
});

const rename = defineTool({
  name: "rename_item",
  title: "Rename item",
  description:
    "Rename a file or folder in place. Its public links, file requests, direct sharing, and stars stay with it, including those on items inside a folder.",
  scope: McpScope.write,
  annotations: destructive,
  input: z.object({ path: pathInput, newName: z.string().max(255) }),
  output: z.object({ path: z.string() }),
  async run({ caller }, input) {
    return {
      path: (
        await caller.files.rename({ path: input.path, newName: input.newName })
      ).path,
    };
  },
});

const move = defineTool({
  name: "move_item",
  title: "Move item",
  description:
    "Move a file or folder into another folder, keeping its name. Moving a folder needs admin permission on it. Its public links, file requests, direct sharing, and stars move with it, but access inherited from its old parent folders is replaced by the destination folder's.",
  scope: McpScope.write,
  annotations: destructive,
  input: z.object({ path: pathInput, destinationFolder: pathInput }),
  output: z.object({ path: z.string() }),
  async run({ caller }, input) {
    return {
      path: (
        await caller.files.move({
          sourcePath: input.path,
          destinationPath: input.destinationFolder,
        })
      ).path,
    };
  },
});

const copy = defineTool({
  name: "copy_item",
  title: "Copy item",
  description:
    "Copy a file or folder into another folder. A taken name gets a number added, such as \"report (1).txt\". It needs read permission on the item and write permission on the destination. The copy has the destination folder's permissions, without the original's public links, file requests, direct sharing, or stars.",
  scope: McpScope.write,
  annotations: additive,
  input: z.object({ path: pathInput, destinationFolder: pathInput }),
  output: z.object({ path: z.string() }),
  async run({ caller }, input) {
    return {
      path: (
        await caller.files.copy({
          sourcePath: input.path,
          destinationPath: input.destinationFolder,
        })
      ).path,
    };
  },
});

const listVersions = defineTool({
  name: "list_versions",
  title: "List file versions",
  description:
    "List earlier versions of a file, newest first. Nimbus keeps the previous content whenever a file is replaced, for up to 30 days and 25 versions per file.",
  scope: McpScope.read,
  annotations: readOnly,
  input: z.object({ path: pathInput }),
  output: z.object({
    versions: z.array(
      z.object({
        versionId: z.string(),
        size: z.number(),
        modifiedAt: z.string(),
        archivedAt: z.string(),
        archivedBy: z.string().nullable(),
      }),
    ),
  }),
  async run({ caller }, input) {
    const versions = await caller.versions.list({ path: input.path });
    return {
      versions: versions.map((version) => ({
        versionId: version.id,
        size: version.size,
        modifiedAt: isoTime(version.modifiedAt),
        archivedAt: isoTime(version.archivedAt),
        archivedBy: version.archivedBy,
      })),
    };
  },
});

const restoreVersion = defineTool({
  name: "restore_version",
  title: "Restore a file version",
  description:
    "Replace a file's content with one of its earlier versions from list_versions. The current content is kept as a new version, so this can be undone.",
  scope: McpScope.write,
  annotations: destructive,
  input: z.object({ path: pathInput, versionId: z.uuid() }),
  output: z.object({ path: z.string() }),
  async run({ caller }, input) {
    const target = await safePath(input.path);
    await caller.versions.restore({
      path: target.relative,
      id: input.versionId,
    });
    return { path: target.relative };
  },
});

const trash = defineTool({
  name: "move_to_trash",
  title: "Move to trash",
  description:
    "Move a file or folder to trash. It can be restored for 30 days with restore_from_trash. While it is in trash its public links, file requests, direct sharing, and stars stop working; restoring it brings them back.",
  scope: McpScope.write,
  annotations: destructive,
  input: z.object({ path: pathInput }),
  output: z.object({ trashId: z.string(), originalPath: z.string() }),
  async run({ caller }, input) {
    const { path, trashId } = await caller.files.delete({ path: input.path });
    return { trashId, originalPath: path };
  },
});

const restore = defineTool({
  name: "restore_from_trash",
  title: "Restore from trash",
  description:
    "Restore a trashed item to its original location. The original parent folder must exist and nothing may occupy the original path.",
  scope: McpScope.write,
  annotations: additive,
  input: z.object({ trashId: z.uuid() }),
  output: z.object({ path: z.string() }),
  async run({ caller }, input) {
    return { path: (await caller.trash.restore({ id: input.trashId })).path };
  },
});

const star = defineTool({
  name: "set_starred",
  title: "Star or unstar",
  description:
    "Star or unstar a file or folder for yourself. Starred items appear under Starred in Nimbus.",
  scope: McpScope.write,
  annotations: idempotentChange,
  input: z.object({ path: pathInput, starred: z.boolean() }),
  output: z.object({ path: z.string(), starred: z.boolean() }),
  async run({ caller }, input) {
    const target = await safePath(input.path);
    await caller.catalog.bookmark({
      path: target.relative,
      starred: input.starred,
    });
    return { path: target.relative, starred: input.starred };
  },
});

export const fileTools = [
  listFolder,
  stat,
  search,
  readText,
  downloadLink,
  uploadLink,
  sharedWithMe,
  listTrash,
  writeText,
  createFolder,
  rename,
  move,
  copy,
  trash,
  restore,
  star,
  listVersions,
  restoreVersion,
];
