import { useCallback } from "react";
import { toast } from "sonner";

import { queryClient, trpcClient } from "@/lib/trpc";

function invalidateFileQueries(currentPath: string, includeStats: boolean) {
  queryClient.invalidateQueries({ queryKey: ["files.list", currentPath, includeStats] });
  queryClient.invalidateQueries({ queryKey: ["files.storage"] });
}

type UseFileActionsOptions = {
  currentPath: string;
  includeStats: boolean;
};

export function useFileActions({ currentPath, includeStats }: UseFileActionsOptions) {
  const createFolder = useCallback(
    async (name: string) => {
      try {
        await trpcClient.files.createFolder.mutate({
          path: currentPath || undefined,
          name,
        });
        invalidateFileQueries(currentPath, includeStats);
        toast.success(`Created folder "${name}"`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create folder.";
        toast.error(message);
        throw error;
      }
    },
    [currentPath, includeStats],
  );

  const renameEntry = useCallback(
    async (entryPath: string, newName: string) => {
      try {
        await trpcClient.files.rename.mutate({ path: entryPath, newName });
        invalidateFileQueries(currentPath, includeStats);
        toast.success(`Renamed to "${newName}"`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to rename.";
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
        invalidateFileQueries(currentPath, includeStats);
        toast.success("Moved successfully");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to move.";
        toast.error(message);
        throw error;
      }
    },
    [currentPath, includeStats],
  );

  const deleteEntry = useCallback(
    async (entryPath: string) => {
      try {
        await trpcClient.files.delete.mutate({ path: entryPath });
        invalidateFileQueries(currentPath, includeStats);
        toast.success("Deleted");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete.";
        toast.error(message);
        throw error;
      }
    },
    [currentPath, includeStats],
  );

  const downloadFile = useCallback((filePath: string) => {
    const url = `/api/files/download?path=${encodeURIComponent(filePath)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  return {
    createFolder,
    renameEntry,
    moveEntry,
    deleteEntry,
    downloadFile,
  };
}
