import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { getDataRoot } from "@nimbus/api/data-root";
import { statPath } from "@nimbus/api/fs-utils";

type StatRequest = { type: "stat-request"; path: string };
type WarmUpRequest = { type: "warm-up"; root: string };
type SweepRequest = { type: "sweep"; root: string };
type WorkerRequest = StatRequest | WarmUpRequest | SweepRequest;

type StatResult = {
  type: "stat-result";
  relativePath: string;
  size: number;
  mtime: number;
};

type StatDeleted = {
  type: "stat-deleted";
  relativePath: string;
};

type WarmUpDone = {
  type: "warm-up-done";
  scanned: number;
  elapsedMs: number;
};

type SweepDone = {
  type: "sweep-done";
  scanned: number;
  elapsedMs: number;
};

type WorkerResponse = StatResult | StatDeleted | WarmUpDone | SweepDone;

const dataRoot = getDataRoot();

const normalizeRelative = (value: string) => value.split(path.sep).join("/");

const shouldIgnoreRelative = (value: string) =>
  normalizeRelative(value).split("/").includes(".nimbus");

const toRelative = (absolutePath: string) => {
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

const post = (message: WorkerResponse) => {
  postMessage(message);
};

const statEntry = async (absolutePath: string) => {
  const relative = toRelative(absolutePath);
  if (!relative) {
    return;
  }
  try {
    const stats = await statPath(absolutePath);
    post({
      type: "stat-result",
      relativePath: relative,
      size: stats.size,
      mtime: stats.mtimeMs,
    });
  } catch (error) {
    const cause = error as { code?: string };
    if (cause.code === "ENOENT") {
      post({ type: "stat-deleted", relativePath: relative });
    }
  }
};

const walkTree = async (
  root: string,
  onEntry: (absolutePath: string) => Promise<void>,
) => {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === ".nimbus" || entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await onEntry(fullPath);
      await walkTree(fullPath, onEntry);
      continue;
    }
    if (entry.isFile()) {
      await onEntry(fullPath);
    }
  }
};

const runScan = async (root: string) => {
  let scanned = 0;
  await walkTree(root, async (absolutePath) => {
    scanned += 1;
    await statEntry(absolutePath);
  });
  return scanned;
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "stat-request") {
    await statEntry(message.path);
    return;
  }

  if (message.type === "warm-up") {
    const start = Date.now();
    const scanned = await runScan(message.root);
    post({
      type: "warm-up-done",
      scanned,
      elapsedMs: Date.now() - start,
    });
    return;
  }

  if (message.type === "sweep") {
    const start = Date.now();
    const scanned = await runScan(message.root);
    post({
      type: "sweep-done",
      scanned,
      elapsedMs: Date.now() - start,
    });
  }
};
