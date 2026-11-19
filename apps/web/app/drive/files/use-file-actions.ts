import { useCallback } from "react";
import { toast } from "@/lib/toast";

import { queryClient, trpcClient } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import { fileListQueryOptions } from "./use-file-list";

import { BulkResult } from "./bulk-result";
import { FileEntry } from "./types";

function invalidateFileQueries() {
  void queryClient.invalidateQueries({ queryKey: ["files.list"] });
  void queryClient.invalidateQueries({ queryKey: ["catalog"] });
  void queryClient.invalidateQueries({ queryKey: ["trash"] });
  void queryClient.invalidateQueries({ queryKey: ["shares"] });
  void queryClient.invalidateQueries({ queryKey: ["files.storage"] });
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

function downloadFrame() {
  const name = "nimbus-download-frame";
  const existing = document.querySelector<HTMLIFrameElement>(
    `iframe[name="${name}"]`,
  );
  if (existing) return existing;
  const frame = document.createElement("iframe");
  frame.name = name;
  frame.hidden = true;
  frame.addEventListener("load", () => {
    const text = frame.contentDocument?.body?.textContent ?? "";
    if (!text) return;
    let message =
      "The ZIP download could not start. Refresh the folder and try again.";
    try {
      const body: unknown = JSON.parse(text);
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
      )
        message = `The ZIP download could not start. ${body.error}`;
    } catch {
      // A non-JSON error page keeps the generic message.
    }
    toast.error(message);
  });
  document.body.append(frame);
  return frame;
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

  const reportBulk = (result: BulkResult, verb: string, place = "") => {
    invalidateFileQueries();
    const summary = BulkResult.describe(result, verb, place);
    if (summary.ok) toast.success(summary.message);
    else toast.error(summary.message);
    return result;
  };

  const moveEntries = useCallback(
    async (entries: readonly FileEntry[], destinationPath: string) =>
      reportBulk(
        await BulkResult.run(FileEntry.outermost(entries), (entry) =>
          trpcClient.files.move.mutate({
            sourcePath: entry.path,
            destinationPath,
          }),
        ),
        "Moved",
      ),
    [],
  );

  const copyEntries = useCallback(
    async (entries: readonly FileEntry[], destinationPath: string) =>
      reportBulk(
        await BulkResult.run(FileEntry.outermost(entries), (entry) =>
          trpcClient.files.copy.mutate({
            sourcePath: entry.path,
            destinationPath,
          }),
        ),
        "Copied",
      ),
    [],
  );

  const trashEntries = useCallback(
    async (entries: readonly FileEntry[]) =>
      reportBulk(
        await BulkResult.run(FileEntry.outermost(entries), (entry) =>
          trpcClient.files.delete.mutate({ path: entry.path }),
        ),
        "Moved",
        " to trash",
      ),
    [],
  );

  /**
   * Star every entry (`starred`), or remove their stars, as the control that offered it said
   * (see `Starring`), so the outcome always matches its label.
   */
  const setStarred = useCallback(
    async (entries: readonly FileEntry[], starred: boolean) => {
      const result = await BulkResult.run(entries, (entry) =>
        trpcClient.catalog.bookmark.mutate({ path: entry.path, starred }),
      );
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
      if (entries.length === 1 && result.failed.length === 0)
        toast.success(starred ? "Added to Starred" : "Removed from Starred");
      else {
        const summary = BulkResult.describe(
          result,
          starred ? "Starred" : "Unstarred",
        );
        if (summary.ok) toast.success(summary.message);
        else toast.error(summary.message);
      }
      return result;
    },
    [],
  );

  /**
   * One ZIP of several entries, streamed by the server straight to the browser's download manager.
   * A form POST avoids URL length limits. It targets a hidden frame: downloads never load a
   * document there, so a load means the server answered with an error to show instead.
   */
  const downloadEntries = useCallback((entries: readonly FileEntry[]) => {
    const frame = downloadFrame();
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/files/archive";
    form.target = frame.name;
    form.hidden = true;
    for (const entry of entries) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "path";
      input.value = entry.path;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
    form.remove();
  }, []);

  const recordVisit = useCallback(async (filePath: string) => {
    try {
      await trpcClient.catalog.bookmark.mutate({ path: filePath });
      await queryClient.invalidateQueries({
        queryKey: ["catalog", "bookmarks"],
      });
    } catch (error) {
      // An item that no longer exists says so where it was opened.
      if (trpcErrorCode(error) === "NOT_FOUND") return;
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
      void queryClient.prefetchQuery({
        ...fileListQueryOptions(entry.path, includeStats),
        staleTime: 30_000,
      });
    },
    [includeStats],
  );

  return {
    createFolder,
    renameEntry,
    moveEntry,
    moveEntries,
    copyEntries,
    trashEntries,
    setStarred,
    downloadEntries,
    deleteEntry,
    downloadFile,
    recordVisit,
    prefetchFolder,
  };
}
