type StatLike = {
  size?: unknown;
  mtime?: unknown;
  mtimeMs?: unknown;
  isDirectory?: unknown;
  isFile?: unknown;
  type?: unknown;
};

export type StatSummary = {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  isFile: boolean;
};

type BunFileLike = {
  stat: () => Promise<unknown>;
};

type BunGlobal = {
  file?: (path: string) => BunFileLike;
};

const toNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return null;
};

const callBoolean = (stats: StatLike, fn: unknown) => {
  if (typeof fn !== "function") {
    return null;
  }
  const result = (fn as (this: StatLike) => unknown).call(stats);
  return typeof result === "boolean" ? result : null;
};

const toMtimeMs = (stats: StatLike) => {
  const direct = toNumber(stats.mtimeMs);
  if (direct !== null) {
    return direct;
  }
  const mtime = stats.mtime;
  if (mtime instanceof Date) {
    return mtime.getTime();
  }
  return toNumber(mtime);
};

const toIsDirectory = (stats: StatLike) => {
  const fromMethod = callBoolean(stats, stats.isDirectory);
  if (fromMethod !== null) {
    return fromMethod;
  }
  if (typeof stats.type === "string") {
    if (stats.type === "directory" || stats.type === "dir") {
      return true;
    }
    if (stats.type === "file") {
      return false;
    }
  }
  return null;
};

const toIsFile = (stats: StatLike, fallbackDir: boolean | null) => {
  const fromMethod = callBoolean(stats, stats.isFile);
  if (fromMethod !== null) {
    return fromMethod;
  }
  if (typeof stats.type === "string") {
    if (stats.type === "file") {
      return true;
    }
    if (stats.type === "directory" || stats.type === "dir") {
      return false;
    }
  }
  if (fallbackDir !== null) {
    return !fallbackDir;
  }
  return null;
};

const toSummary = (stats: unknown): StatSummary | null => {
  if (!stats || typeof stats !== "object") {
    return null;
  }
  const statLike = stats as StatLike;
  const size =
    toNumber(statLike.size) ??
    (typeof statLike.type === "string" &&
    (statLike.type === "directory" || statLike.type === "dir")
      ? 0
      : null);
  const mtimeMs = toMtimeMs(statLike);
  const isDirectory = toIsDirectory(statLike);
  const isFile = toIsFile(statLike, isDirectory);
  if (
    size === null ||
    mtimeMs === null ||
    isDirectory === null ||
    isFile === null
  ) {
    return null;
  }
  return { size, mtimeMs, isDirectory, isFile };
};

const getBunFile = (absolutePath: string) => {
  const bun = (globalThis as { Bun?: BunGlobal }).Bun;
  if (!bun || typeof bun.file !== "function") {
    return null;
  }
  return bun.file(absolutePath);
};

export const statPath = async (absolutePath: string): Promise<StatSummary> => {
  const bunFile = getBunFile(absolutePath);
  if (!bunFile) {
    throw new Error("Bun runtime required for statPath.");
  }
  const stats = await bunFile.stat();
  const summary = toSummary(stats);
  if (!summary) {
    throw new Error("Bun stat did not return expected fields.");
  }
  return summary;
};
