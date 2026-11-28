import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { LeaveGuard } from "@/lib/leave-guard";
import { toast } from "@/lib/toast";

import { queryClient, trpcClient } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import { fileListQueryOptions } from "./use-file-list";

import { BulkResult } from "./bulk-result";
import type { TransferOperation, TransferResult } from "./transfer-result";
import { DropTarget } from "./drop-target";
import { TransferCode } from "./transfer-code";
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
  /**
   * Offered a move made without the picker whose names clash in the destination, to show the
   * choices; says whether it took it (see `useClashHandoff`). A move it does not take, or any
   * without it, is reported with Keep both.
   */
  onClashes?: (result: TransferResult) => boolean;
};

export function useFileActions({
  currentPath,
  includeStats,
  onClashes,
}: UseFileActionsOptions) {
  const clashes = useRef(onClashes);
  useEffect(() => {
    clashes.current = onClashes;
  });
  const createFolder = useCallback(
    // In the folder shown, or in `parent`, as New off a folder page creates in the Files home.
    async (name: string, parent = currentPath) => {
      try {
        await trpcClient.files.createFolder.mutate({
          path: parent || undefined,
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

  const navigate = useNavigate();

  // Every transfer the server may have carried out ends in a report the person can reach,
  // whatever the page was doing when its answer arrived. Each transfer runs through
  // `transferEntries`, and its result goes to exactly one owner: the picker that started it
  // (or was opened fresh for its clashes), which reports when it closes, or `reportTransfer`,
  // straight away. A result is never handed to UI that did not take it.

  /**
   * Move or copy `entries` into `destinationPath` without reporting. `clash` says what happens
   * to a taken name (see `files.move`); `names` gives single items a name of their own.
   */
  const transferEntries = useCallback(
    async (
      operation: TransferOperation,
      entries: readonly FileEntry[],
      destinationPath: string,
      options: {
        clash?: "refuse" | "keep-both";
        names?: ReadonlyMap<string, string>;
        /** Whether something on screen shows it running, such as the picker that sent it. */
        watched?: () => boolean;
        /** Cancels the transfer once aborted (see `TransferResult.run`). */
        signal?: AbortSignal;
      } = {},
    ) => {
      const items = FileEntry.outermost(entries);
      // Nothing is sent unless what reports it has loaded: otherwise nothing has changed, and
      // every item says so.
      const code = await TransferCode.load().catch(() => null);
      if (!code)
        return {
          operation,
          destination: destinationPath,
          transferred: [],
          clashes: [],
          skipped: [],
          failed: items.map((source) => ({
            source,
            reason: `Nothing was ${operation === "move" ? "moved" : "copied"}: part of Nimbus could not load. Reload the page and try again.`,
          })),
          alreadyThere: [],
          unconfirmed: [],
          cancelled: [],
        } satisfies TransferResult;
      const [{ TransferResult }] = code;
      // Items already in the destination stay as they are, and the result says so; the
      // others move there.
      const moving =
        operation === "move" ? DropTarget.notIn(items, destinationPath) : items;
      const staying = items.filter((item) => !moving.includes(item));
      const result = await TransferResult.run(
        operation,
        destinationPath,
        moving,
        (entry, transfer) =>
          trpcClient.files[operation].mutate({
            sourcePath: entry.path,
            destinationPath,
            name: options.names?.get(entry.path),
            clash: options.clash,
            transfer,
          }),
        {
          hold: LeaveGuard.hold,
          watched: options.watched,
          signal: options.signal,
          cancel: (transfer) =>
            trpcClient.files.cancelTransfer.mutate({ transfer }),
        },
      );
      return { ...result, alreadyThere: staying };
    },
    [],
  );

  /**
   * Report what a transfer did, with Undo, in one toast with transfers to other destinations
   * made along with it (`also`), such as by one picker. The report's code loads on first use.
   */
  const reportTransfer = useCallback(
    function report(
      result: TransferResult,
      also: readonly TransferResult[] = [],
    ): TransferResult {
      invalidateFileQueries();
      // Loaded before the transfer started (see `transferEntries`), unless it never started.
      void TransferCode.load().then(
        ([, { TransferReport }]) =>
          TransferReport.show([result, ...also], {
            refresh: invalidateFileQueries,
            hold: LeaveGuard.hold,
            open: (folder) =>
              void navigate({ href: TransferReport.folderHref(folder) }),
            // Opens the picker at the clashes, when the page is shown with no dialog open.
            choose: clashes.current
              ? (earlier) => clashes.current?.(earlier) ?? false
              : undefined,
            keepBoth: (earlier) =>
              void Promise.all(
                earlier.map((result) =>
                  transferEntries(
                    result.operation,
                    result.clashes.map((clash) => clash.source),
                    result.destination,
                    { clash: "keep-both" },
                  ),
                ),
              ).then(([first, ...others]) => first && report(first, others)),
          }),
        // Only when the transfer never started, which its items say.
        () =>
          toast.error(
            result.failed[0]?.reason ??
              "Nimbus could not show this report. Reload the page, then check the folder.",
          ),
      );
      return result;
    },
    [navigate, transferEntries],
  );

  /**
   * Move or copy without the picker, as drops, Move up one level and the split view's "Move to"
   * and "Copy to" do. A taken name is never replaced, nor a copy renamed unasked: name clashes go
   * to a picker opened for them, which reports the whole transfer once they are decided. When
   * the page cannot open one, such as while another dialog is open or after the person left the
   * page, this reports the transfer at once, with Undo for what moved and the clashes' choices.
   */
  const transferDirectly = useCallback(
    async (
      operation: TransferOperation,
      entries: readonly FileEntry[],
      destinationPath: string,
    ) => {
      // Moves refuse by default; copies keep both unless told otherwise (see `files.copy`).
      const result = await transferEntries(
        operation,
        entries,
        destinationPath,
        operation === "copy" ? { clash: "refuse" } : {},
      );
      // A cancelled transfer is reported as it stands: the person asked it to stop.
      if (
        result.clashes.length &&
        !result.cancelled.length &&
        clashes.current?.(result)
      ) {
        invalidateFileQueries();
        return result;
      }
      return reportTransfer(result);
    },
    [reportTransfer, transferEntries],
  );

  const moveEntries = useCallback(
    (entries: readonly FileEntry[], destinationPath: string) =>
      transferDirectly("move", entries, destinationPath),
    [transferDirectly],
  );

  const copyEntries = useCallback(
    (entries: readonly FileEntry[], destinationPath: string) =>
      transferDirectly("copy", entries, destinationPath),
    [transferDirectly],
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
      // Nothing changed when every item failed; the lists already show the truth.
      if (result.succeeded > 0)
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
      // An item that no longer exists, or may not be opened, says so where it was opened.
      const code = trpcErrorCode(error);
      if (code === "NOT_FOUND" || code === "FORBIDDEN") return;
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
    /** Holds the page while work runs that leaving would lose (see `LeaveGuard`). */
    holdPage: LeaveGuard.hold,
    createFolder,
    renameEntry,
    transferEntries,
    reportTransfer,
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
