import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { trpcClient } from "@/lib/trpc";

import type { FileEntry } from "./types";

type UseFileListOptions = {
  currentPath: string;
  includeStats: boolean;
  enabled: boolean;
};

export const useFileList = ({
  currentPath,
  includeStats,
  enabled,
}: UseFileListOptions) => {
  const listQuery = useQuery({
    queryKey: ["files.list", currentPath, includeStats],
    queryFn: () =>
      trpcClient.files.list.query(
        currentPath ? { path: currentPath, includeStats } : { includeStats },
      ),
    enabled,
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
