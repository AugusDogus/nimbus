import { useCallback } from "react";
import { toast } from "sonner";

import { queryClient, trpcClient } from "@/lib/trpc";

import type { FileEntry } from "./types";

function invalidateFileQueries() {
  void queryClient.invalidateQueries({ queryKey: ["files.list"] });
  void queryClient.invalidateQueries({ queryKey: ["catalog"] });
  void queryClient.invalidateQueries({ queryKey: ["trash"] });
  void queryClient.invalidateQueries({ queryKey: ["shares"] });
  queryClient.invalidateQueries({ queryKey: ["files.storage"] });
}

function buildRenamedPath(entryPath: string, newName: string) {
  const slashIndex = entryPath.lastIndexOf("/");
  if (slashIndex < 0) {
    return newName;
  }
  return `${entryPath.slice(0, slashIndex)}/${newName}`;
}

function updateRenameInCache(
  currentPath: string,
  includeStats: boolean,
  entryPath: string,
  newName: string,
) {
  const listKey = ["files.list", currentPath, includeStats];
  queryClient.setQueryData(listKey, (prev: FileEntry[] | undefined) => {
    if (!prev) return prev;
    const newPath = buildRenamedPath(entryPath, newName);
    return prev.map((entry) =>
      entry.path === entryPath
        ? {
            ...entry,
            name: newName,
            path: newPath,
          }
        : entry,
    );
  });
}

type UseFileActionsOptions = {
  currentPath: string;
  includeStats: boolean;
};

export function useFileActions({
  currentPath,
  includeStats,
}: UseFileActionsOptions) {
  const createFolder = useCallback(
    async (name: string) => {
      try {
        await trpcClient.files.createFolder.mutate({
          path: currentPath || undefined,
          name,
        });
        invalidateFileQueries();
        toast.success(`Created folder "${name}"`);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to create folder.";
        toast.error(message);
        throw error;
      }
    },
    [currentPath],
  );

  const renameEntry = useCallback(
    async (entryPath: string, newName: string) => {
      try {
        await trpcClient.files.rename.mutate({ path: entryPath, newName });
        updateRenameInCache(currentPath, includeStats, entryPath, newName);
        invalidateFileQueries();
        toast.success(`Renamed to "${newName}"`);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to rename.";
        toast.error(message);
        throw error;
      }
    },
    [currentPath, includeStats],
  );

  const moveEntry = useCallback(
    async (sourcePath: string, destinationPath: string) => {
      try {
        await trpcClient.files.move.mutate({ sourcePath, destinationPath });
        invalidateFileQueries();
        toast.success("Moved successfully");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to move.";
        toast.error(message);
        throw error;
      }
    },
    [],
  );

  const deleteEntry = useCallback(async (entryPath: string) => {
    try {
      await trpcClient.files.delete.mutate({ path: entryPath });
      invalidateFileQueries();
      toast.success("Moved to trash");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to delete.";
      toast.error(message);
      throw error;
    }
  }, []);

  const downloadFile = useCallback((filePath: string, zip = false) => {
    const url = `/api/files/download?path=${encodeURIComponent(filePath)}${zip ? "&zip=1" : ""}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const toggleStar = useCallback(async (filePath: string) => {
    try {
      const existing = await trpcClient.catalog.bookmarks.query();
      const starred = !existing.find((entry) => entry.path === filePath)
        ?.starred;
      await trpcClient.catalog.bookmark.mutate({ path: filePath, starred });
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
      toast.success(starred ? "Added to Starred" : "Removed from Starred");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not update starred files.",
      );
    }
  }, []);

  const recordVisit = useCallback(async (filePath: string) => {
    try {
      await trpcClient.catalog.bookmark.mutate({ path: filePath });
      await queryClient.invalidateQueries({
        queryKey: ["catalog", "bookmarks"],
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not update Recent files. Try opening the item again.",
      );
    }
  }, []);

  const prefetchFolder = useCallback(
    (entry: FileEntry) => {
      if (entry.type !== "dir") return;
      const listKey = ["files.list", entry.path, includeStats];
      queryClient.prefetchQuery({
        queryKey: listKey,
        queryFn: () =>
          trpcClient.files.list.query(
            entry.path ? { path: entry.path, includeStats } : { includeStats },
          ),
        staleTime: 30_000,
      });
    },
    [includeStats],
  );

  return {
    createFolder,
    renameEntry,
    moveEntry,
    deleteEntry,
    downloadFile,
    toggleStar,
    recordVisit,
    prefetchFolder,
  };
}
