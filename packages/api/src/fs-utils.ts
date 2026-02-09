import { stat } from "node:fs/promises";

export type StatSummary = {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  isFile: boolean;
};

export const statPath = async (absolutePath: string): Promise<StatSummary> => {
  const stats = await stat(absolutePath);
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
  };
};
