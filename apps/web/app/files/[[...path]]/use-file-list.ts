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

  const entries = useMemo<FileEntry[]>(
    () => listQuery.data ?? [],
    [listQuery.data],
  );

  return {
    entries,
    listQuery,
  };
};
