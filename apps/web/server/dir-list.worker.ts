import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { getDataRoot } from "@nimbus/api/data-root";
import { statPath } from "@nimbus/api/fs-utils";

type ListDirRequest = { type: "list-dir"; path: string };
type WorkerRequest = ListDirRequest;

type DirEntry = {
  name: string;
  path: string;
  type: "dir" | "file" | "other";
};

type DirListResponse = {
  type: "dir-list";
  relativeDir: string;
  entries: DirEntry[];
  dirMtimeMs: number | null;
};

type WorkerResponse = DirListResponse;

const dataRoot = getDataRoot();

const normalizeRelative = (value: string) => value.split(path.sep).join("/");

const shouldIgnoreRelative = (value: string) =>
  normalizeRelative(value)
    .split("/")
    .some((segment) => segment.toLowerCase() === ".nimbus");

const toRelativeDir = (absolutePath: string) => {
  const relative = path.relative(dataRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  const normalized = normalizeRelative(relative);
  if (shouldIgnoreRelative(normalized)) {
    return null;
  }
  return normalized;
};

const listDir = async (absolutePath: string) => {
  const relativeDir = toRelativeDir(absolutePath);
  if (relativeDir === null) {
    return;
  }

  let attempts = 0;
  let dirMtimeMs: number | null = null;
  let mapped: DirEntry[] = [];
  while (attempts < 3) {
    attempts += 1;
    let beforeMtime: number | null = null;
    try {
      const dirStats = await statPath(absolutePath);
      beforeMtime = dirStats.mtimeMs;
    } catch {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(absolutePath, { withFileTypes: true });
    } catch {
      return;
    }

    const filtered = entries.filter(
      (entry) =>
        entry.name.toLowerCase() !== ".nimbus" &&
        (entry.isFile() || entry.isDirectory()),
    );
    mapped = filtered.map((entry) => {
      const entryPath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      return {
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
      };
    });

    let afterMtime: number | null = null;
    try {
      const dirStats = await statPath(absolutePath);
      afterMtime = dirStats.mtimeMs;
    } catch {
      return;
    }

    dirMtimeMs = afterMtime;
    if (beforeMtime === afterMtime) {
      break;
    }
  }

  const response: WorkerResponse = {
    type: "dir-list",
    relativeDir,
    entries: mapped,
    dirMtimeMs,
  };
  postMessage(response);
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "list-dir") {
    await listDir(message.path);
  }
};
