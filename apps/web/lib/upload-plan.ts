import { numberedName } from "@nimbus/api/numbered-name";
import type { UploadRequest } from "./upload-queue";
import type { CollectedUpload } from "./upload-sources";

export type EntryKind = "file" | "dir";

/** A top-level upload item whose name is already used in the target folder. */
export type UploadClash = {
  name: string;
  kind: EntryKind;
  existing: EntryKind;
  /** Files the item contains: 1 for a file. */
  files: number;
};

/**
 * - `replace`: overwrite a file, or merge into a folder and overwrite files with the same names.
 * - `keep-both`: upload beside the existing item under a numbered name.
 * - `skip`: leave this item out.
 */
export type ClashChoice = "replace" | "keep-both" | "skip";

const topOf = (folder: string, filename: string) => {
  const slash = folder.indexOf("/");
  return folder ? (slash < 0 ? folder : folder.slice(0, slash)) : filename;
};

function tops(upload: CollectedUpload) {
  const result = new Map<string, { kind: EntryKind; files: number }>();
  for (const { file, folder } of upload.sources) {
    const name = topOf(folder, file.name);
    const current = result.get(name) ?? {
      kind: folder ? "dir" : "file",
      files: 0,
    };
    current.files++;
    result.set(name, current);
  }
  for (const folder of upload.emptyFolders) {
    const name = topOf(folder, "");
    if (!result.has(name)) result.set(name, { kind: "dir", files: 0 });
  }
  return result;
}

/** Top-level names in the upload that already exist in the target, in upload order. */
function clashes(
  upload: CollectedUpload,
  existing: ReadonlyMap<string, EntryKind>,
): UploadClash[] {
  const found: UploadClash[] = [];
  for (const [name, top] of tops(upload)) {
    const kind = existing.get(name);
    if (kind)
      found.push({ name, kind: top.kind, existing: kind, files: top.files });
  }
  return found;
}

/** Whether `replace` makes sense: files replace files, folders merge into folders. */
const canReplace = (clash: Pick<UploadClash, "kind" | "existing">) =>
  clash.kind === clash.existing;

/**
 * Turn collected files and clash decisions into upload requests and folders to create.
 * Unresolved clashes keep both, matching the server's behavior for clashes that appear mid-upload.
 */
function plan(
  upload: CollectedUpload,
  existing: ReadonlyMap<string, EntryKind>,
  choices: ReadonlyMap<string, ClashChoice>,
  target: { path: string; userId: string },
) {
  const renamed = new Map<string, string>();
  const replacing = new Set<string>();
  const skipped = new Set<string>();
  // A new name must be free in the folder and among the upload's own top-level items, or two
  // uploaded folders would merge into one.
  const used = new Set([...existing.keys(), ...tops(upload).keys()]);
  for (const clash of clashes(upload, existing)) {
    const choice = choices.get(clash.name) ?? "keep-both";
    if (choice === "skip") skipped.add(clash.name);
    else if (choice === "replace" && canReplace(clash))
      replacing.add(clash.name);
    else if (clash.kind === "dir") {
      // Files get numbered names on the server. A folder's new name must be chosen here, for all its files.
      let index = 1;
      while (used.has(numberedName(clash.name, index, false))) index++;
      const name = numberedName(clash.name, index, false);
      used.add(name);
      renamed.set(clash.name, name);
    }
  }
  const rename = (folder: string) => {
    const top = topOf(folder, "");
    const name = renamed.get(top);
    return name ? name + folder.slice(top.length) : folder;
  };
  const requests: UploadRequest[] = [];
  for (const { file, folder } of upload.sources) {
    const top = topOf(folder, file.name);
    if (skipped.has(top)) continue;
    requests.push({
      file,
      filename: file.name,
      targetPath: target.path,
      folder: rename(folder),
      conflict: replacing.has(top) ? "replace" : "keep-both",
      userId: target.userId,
    });
  }
  const folders = upload.emptyFolders
    .filter((folder) => !skipped.has(topOf(folder, "")))
    .map(rename);
  return { requests, folders };
}

export const UploadPlan = { clashes, canReplace, plan } as const;
