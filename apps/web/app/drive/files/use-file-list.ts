import { useMemo } from "react";

import {
  keepPreviousData,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";

import { fetchFileList } from "@/lib/file-list";
import { trpcErrorCode } from "@/lib/trpc-error";

import type { FileEntry } from "./types";

type UseFileListOptions = {
  currentPath: string;
  includeStats: boolean;
  enabled: boolean;
};

/** The listing of the folder at `path`, with sizes and dates when `includeStats`. */
export const fileListQueryOptions = (path: string, includeStats: boolean) =>
  queryOptions<FileEntry[]>({
    queryKey: ["files.list", path, includeStats],
    queryFn: () => fetchFileList(path, includeStats),
    // A missing folder stays missing, and a refused one refused: say so at once, not after retries.
    retry: (failures, error) => {
      const code = trpcErrorCode(error);
      return code !== "NOT_FOUND" && code !== "FORBIDDEN" && failures < 3;
    },
  });

export const useFileList = ({
  currentPath,
  includeStats,
  enabled,
}: UseFileListOptions) => {
  const listQuery = useQuery({
    ...fileListQueryOptions(currentPath, includeStats),
    enabled,
    placeholderData: keepPreviousData,
  });
  const entries = useMemo<FileEntry[]>(() => {
    const data = listQuery.data ?? [];
    // Multiple cache updaters (optimistic rename, subscription, refetch)
    // can briefly produce duplicates. Deduplicate by path, keeping the
    // last occurrence (most recently written).
    const seen = new Map<string, FileEntry>();
    for (const entry of data) {
      seen.set(entry.path, entry);
    }
    return seen.size === data.length ? data : [...seen.values()];
  }, [listQuery.data]);

  return {
    entries,
    listQuery,
  };
};
