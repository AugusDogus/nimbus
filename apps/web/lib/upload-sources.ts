/** A file to upload and the folders, relative to the upload target, that contain it. */
export type UploadSource = { file: File; folder: string };

export type CollectedUpload = {
  sources: UploadSource[];
  /** Folders with no files anywhere inside, relative to the upload target. */
  emptyFolders: string[];
  /** Entries that could not be read, such as broken links or files removed during the drop. */
  skipped: string[];
};

// Finder writes these into every folder it opens. They are never what someone means to upload.
const ignored = new Set([".DS_Store"]);

const isDirectory = (
  entry: FileSystemEntry,
): entry is FileSystemDirectoryEntry => entry.isDirectory;
const isFile = (entry: FileSystemEntry): entry is FileSystemFileEntry =>
  entry.isFile;

/** A directory reader returns at most about 100 entries per call. Drain the same reader until empty. */
async function readAll(directory: FileSystemDirectoryEntry) {
  const reader = directory.createReader();
  const entries: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

const readFile = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/**
 * Collect files and folders from a drop, preserving folder structure. Entries must be captured
 * synchronously: the DataTransfer is emptied when the drop handler returns.
 */
export function collectDrop(transfer: DataTransfer): Promise<CollectedUpload> {
  const roots: FileSystemEntry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) roots.push(entry);
    else {
      const file = item.getAsFile();
      if (file) loose.push(file);
    }
  }
  return (async () => {
    const result: CollectedUpload = {
      sources: loose.map((file) => ({ file, folder: "" })),
      emptyFolders: [],
      skipped: [],
    };
    // Breadth first with an explicit stack, so deep trees cannot overflow the call stack.
    const pending: { entry: FileSystemEntry; folder: string }[] = roots.map(
      (entry) => ({ entry, folder: "" }),
    );
    for (let next = pending.shift(); next; next = pending.shift()) {
      const { entry, folder } = next;
      if (ignored.has(entry.name)) continue;
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      try {
        if (isFile(entry))
          result.sources.push({ file: await readFile(entry), folder });
        else if (isDirectory(entry)) {
          const children = await readAll(entry);
          if (children.every((child) => ignored.has(child.name)))
            result.emptyFolders.push(path);
          for (const child of children)
            pending.push({ entry: child, folder: path });
        }
      } catch {
        result.skipped.push(path);
      }
    }
    return result;
  })();
}

/** Files from a folder picker carry their path, including the chosen folder, in `webkitRelativePath`. */
export function collectPicked(files: readonly File[]): CollectedUpload {
  const sources: UploadSource[] = [];
  for (const file of files) {
    if (ignored.has(file.name)) continue;
    const relative = file.webkitRelativePath;
    const folder = relative.includes("/")
      ? relative.slice(0, relative.lastIndexOf("/"))
      : "";
    sources.push({ file, folder });
  }
  return { sources, emptyFolders: [], skipped: [] };
}
