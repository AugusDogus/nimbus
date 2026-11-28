import { useMemo } from "react";

import {
  keepPreviousData,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";

import { fetchFileList } from "@/lib/file-list";
import { queryClient } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";

import { sortEntries } from "./entry-sort";
import { prepareEntryIcons } from "./file-icons";
import { prefsQueryOptions } from "./use-file-preferences";
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
    // A listing shows with its icons ready, so no row paints an empty or changing icon.
    queryFn: async () => {
      const entries = await fetchFileList(path, includeStats);
      // In the order the page shows them, so the first screen's icons are the ones awaited.
      const prefs = queryClient.getQueryData(prefsQueryOptions.queryKey);
      await prepareEntryIcons(
        prefs ? sortEntries(entries, prefs) : entries,
        path,
      );
      return entries;
    },
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
    // While a listing loads: the one shown before, or the folder's listing without or with
    // sizes and dates, so a folder this page has listed before never shows as loading.
    placeholderData: (previous) =>
      keepPreviousData(previous) ??
      queryClient.getQueryData(
        fileListQueryOptions(currentPath, !includeStats).queryKey,
      ),
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
