import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as tus from "tus-js-client";
import { queryClient } from "@/lib/trpc";

export type UploadState = {
  isUploading: boolean;
  progress: number;
  fileName: string | null;
  remaining: number;
};
type QueuedFile = { file: File; path: string; userId: string };
const idle: UploadState = {
  isUploading: false,
  progress: 0,
  fileName: null,
  remaining: 0,
};

export function useUploadQueue() {
  const [state, setState] = useState<UploadState>(idle);
  const uploadRef = useRef<tus.Upload | null>(null);
  const queue = useRef<QueuedFile[]>([]);
  const processNext = useCallback(function next() {
    const item = queue.current[0];
    if (!item) {
      uploadRef.current = null;
      setState(idle);
      return;
    }
    const { file } = item;
    setState({
      isUploading: true,
      progress: 0,
      fileName: file.name,
      remaining: queue.current.length,
    });
    const finish = () => {
      if (uploadRef.current !== upload) return;
      queue.current.shift();
      next();
    };
    const upload = new tus.Upload(file, {
      endpoint: "/api/upload",
      retryDelays: [0, 1000, 3000, 5000],
      removeFingerprintOnSuccess: true,
      fingerprint: async () =>
        JSON.stringify([
          item.userId,
          item.path,
          file.name,
          file.size,
          file.lastModified,
        ]),
      metadata: { filename: file.name, targetPath: item.path },
      onProgress(uploaded, total) {
        if (uploadRef.current === upload)
          setState((previous) => ({
            ...previous,
            progress: total === 0 ? 100 : Math.round((uploaded / total) * 100),
          }));
      },
      onSuccess() {
        if (uploadRef.current !== upload) return;
        toast.success(`Uploaded "${file.name}"`);
        void queryClient.invalidateQueries({
          queryKey: ["files.list", item.path],
        });
        void queryClient.invalidateQueries({ queryKey: ["files.storage"] });
        finish();
      },
      onError(error) {
        if (uploadRef.current !== upload) return;
        toast.error(`Upload failed for "${file.name}": ${error.message}`);
        finish();
      },
    });
    uploadRef.current = upload;
    void upload
      .findPreviousUploads()
      .then((previous) => {
        if (uploadRef.current !== upload) return;
        if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      })
      .catch((error: unknown) => {
        if (uploadRef.current !== upload) return;
        toast.error(
          error instanceof Error ? error.message : "Could not start upload.",
        );
        finish();
      });
  }, []);
  const uploadFiles = useCallback(
    (files: File[], target: { path: string; userId: string }) => {
      queue.current.push(...files.map((file) => ({ file, ...target })));
      if (!uploadRef.current) processNext();
      else
        setState((previous) => ({
          ...previous,
          remaining: queue.current.length,
        }));
    },
    [processNext],
  );
  const cancelUpload = useCallback(() => {
    const upload = uploadRef.current;
    uploadRef.current = null;
    queue.current = [];
    setState(idle);
    if (upload)
      void upload
        .abort()
        .catch(() =>
          toast.error(
            "The upload connection could not be closed. Refresh before uploading again.",
          ),
        );
  }, []);
  useEffect(
    () => () => {
      const upload = uploadRef.current;
      uploadRef.current = null;
      queue.current = [];
      if (upload) void upload.abort();
    },
    [],
  );
  return { ...state, uploadFiles, cancelUpload };
}
