import { useMemo } from "react";

import {
  keepPreviousData,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";

import { fetchFileList } from "@/lib/file-list";

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
