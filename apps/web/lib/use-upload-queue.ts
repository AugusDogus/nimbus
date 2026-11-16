import { useCallback, useEffect, useMemo, useState } from "react";
import { TRPCClientError } from "@trpc/client";
import { toast } from "@/lib/toast";
import { coalesce } from "@/lib/coalesce";
import { queryClient, trpcClient } from "@/lib/trpc";
import { fetchFileList } from "./file-list";
import type { ClashChoice, EntryKind, UploadClash } from "./upload-plan";
import {
  createUploadQueue,
  type UploadSummary,
  type UploadTransport,
} from "./upload-queue";
import type { CollectedUpload } from "./upload-sources";

/** An existing folder is fine when recreating an upload's folder tree. */
function isConflict(error: unknown) {
  if (!(error instanceof TRPCClientError)) return false;
  const data: unknown = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "code" in data &&
    data.code === "CONFLICT"
  );
}

/** Small files send their bytes with the creation request, halving requests for large batches. */
const inlineUploadLimit = 16 * 1024 * 1024;

function failureMessage(
  error: Error,
  detailed: (error: Error) => string | undefined,
) {
  return (
    detailed(error) ||
    error.message ||
    "The upload failed. Check your connection and retry."
  );
}

/** Each upload is an independent tus upload. tus-js-client loads with the first upload, not the page. */
const tusTransport: UploadTransport = (request, events) => {
  let aborted = false;
  let abortUpload: () => Promise<void> = async () => {};
  void import("tus-js-client")
    .then(({ Upload, DetailedError }) => {
      if (aborted) return;
      const detailed = (error: Error) =>
        error instanceof DetailedError
          ? error.originalResponse?.getBody()
          : undefined;
      const { file } = request;
      const upload = new Upload(file, {
        endpoint: "/api/upload",
        retryDelays: [0, 1000, 3000, 5000],
        removeFingerprintOnSuccess: true,
        uploadDataDuringCreation: file.size <= inlineUploadLimit,
        fingerprint: async () =>
          JSON.stringify([
            request.userId,
            request.targetPath,
            request.folder,
            request.filename,
            request.conflict,
            file.size,
            file.lastModified,
          ]),
        metadata: {
          filename: request.filename,
          targetPath: request.targetPath,
          conflict: request.conflict,
          ...(request.folder ? { folder: request.folder } : {}),
        },
        onProgress: (sent) => events.progress(sent),
        onSuccess: () => events.success(),
        onError: (error) => events.failure(failureMessage(error, detailed)),
      });
      // Terminating deletes the partial upload on the server, so a retry starts clean.
      abortUpload = () => upload.abort(true);
      return upload.findPreviousUploads().then((previous) => {
        if (aborted) return;
        const [last] = previous;
        if (last) upload.resumeFromPreviousUpload(last);
        upload.start();
      });
    })
    .catch((error: unknown) =>
      events.failure(
        error instanceof Error
          ? `The upload could not start: ${error.message}`
          : "The upload could not start. Check your connection and retry.",
      ),
    );
  return {
    abort: async () => {
      aborted = true;
      await abortUpload();
    },
  };
};

const plural = (count: number, noun: string) =>
  `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;

function announce(summary: UploadSummary) {
  if (summary.failed > 0)
    toast.error(
      `${plural(summary.failed, "upload")} failed. ${summary.done ? `${plural(summary.done, "file")} uploaded. ` : ""}Open the upload panel to see why and retry.`,
    );
  else if (summary.done > 0)
    toast.success(`Uploaded ${plural(summary.done, "file")}`);
}

/** A clash waiting for the user's decision. Resolving with `all` applies the choice to every remaining clash. */
export type ClashPrompt = {
  clash: UploadClash;
  remaining: number;
  resolve: (choice: ClashChoice, all: boolean) => void;
  cancel: () => void;
};

async function existingNames(path: string) {
  const entries = await fetchFileList(path, false);
  return new Map<string, EntryKind>(
    entries.map((entry) => [entry.name, entry.type === "dir" ? "dir" : "file"]),
  );
}

/** Create empty folders from a folder upload, parents first. Folders that already exist are fine. */
async function createFolders(target: string, folders: readonly string[]) {
  const created = new Set<string>();
  for (const folder of [...folders].sort(
    (a, b) => a.split("/").length - b.split("/").length,
  )) {
    const segments = folder.split("/");
    for (let depth = 1; depth <= segments.length; depth++) {
      const relative = segments.slice(0, depth).join("/");
      if (created.has(relative)) continue;
      created.add(relative);
      const parent = [target, ...segments.slice(0, depth - 1)]
        .filter(Boolean)
        .join("/");
      const name = segments[depth - 1];
      if (!name) continue;
      try {
        await trpcClient.files.createFolder.mutate({
          path: parent || undefined,
          name,
        });
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
  }
}

export function useUploadQueue() {
  const [refresh] = useState(() =>
    coalesce(() => {
      void queryClient.invalidateQueries(
        { queryKey: ["files.list"] },
        { cancelRefetch: false },
      );
      void queryClient.invalidateQueries(
        { queryKey: ["files.storage"] },
        { cancelRefetch: false },
      );
    }, 750),
  );
  const [queue] = useState(() => {
    const created = createUploadQueue({
      transport: tusTransport,
      onUploaded: refresh,
      onIdle(summary) {
        announce(summary);
        // Failures stay listed for retry. A fully successful batch leaves nothing to show.
        if (summary.failed === 0) created.clearFinished();
      },
    });
    return created;
  });
  const [prompt, setPrompt] = useState<ClashPrompt | null>(null);
  useEffect(() => () => queue.dispose(), [queue]);

  /** Ask about each clash in turn, unless the user applies one choice to the rest. */
  const decide = useCallback(async (clashes: readonly UploadClash[]) => {
    const choices = new Map<string, ClashChoice>();
    for (let index = 0; index < clashes.length; index++) {
      const clash = clashes[index];
      if (!clash) continue;
      const answer = await new Promise<{
        choice: ClashChoice;
        all: boolean;
      } | null>((resolve) =>
        setPrompt({
          clash,
          remaining: clashes.length - index - 1,
          resolve: (choice, all) => resolve({ choice, all }),
          cancel: () => resolve(null),
        }),
      );
      if (!answer) {
        setPrompt(null);
        return null;
      }
      choices.set(clash.name, answer.choice);
      if (answer.all)
        for (const rest of clashes.slice(index + 1))
          choices.set(
            rest.name,
            answer.choice === "replace" && rest.kind !== rest.existing
              ? "keep-both"
              : answer.choice,
          );
      if (answer.all) break;
    }
    setPrompt(null);
    return choices;
  }, []);

  const uploadFiles = useCallback(
    async (
      upload: CollectedUpload,
      target: { path: string; userId: string },
    ) => {
      if (upload.sources.length === 0 && upload.emptyFolders.length === 0)
        return;
      if (upload.skipped.length > 0)
        toast.error(
          `${plural(upload.skipped.length, "item")} could not be read and will not upload, starting with “${upload.skipped[0]}”.`,
        );
      try {
        // Planning code loads with the first upload, keeping it out of every page's initial bundle.
        const [{ UploadPlan }, existing] = await Promise.all([
          import("./upload-plan"),
          existingNames(target.path),
        ]);
        const clashes = UploadPlan.clashes(upload, existing);
        const choices = clashes.length
          ? await decide(clashes)
          : new Map<string, ClashChoice>();
        if (!choices) return;
        const { requests, folders } = UploadPlan.plan(
          upload,
          existing,
          choices,
          target,
        );
        if (folders.length) {
          await createFolders(target.path, folders);
          refresh();
        }
        queue.enqueue(requests);
      } catch (error) {
        toast.error(
          `The upload could not start. ${error instanceof Error ? error.message : "Check your connection and try again."} Nothing was uploaded.`,
        );
      }
    },
    [decide, queue, refresh],
  );

  return useMemo(
    () => ({ queue, uploadFiles, prompt }),
    [queue, uploadFiles, prompt],
  );
}
