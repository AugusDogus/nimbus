import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as tus from "tus-js-client";

import { queryClient } from "@/lib/trpc";

export type UploadState = {
  /** Currently uploading */
  isUploading: boolean;
  /** 0-100 progress of the current file */
  progress: number;
  /** Name of the file currently being uploaded */
  fileName: string | null;
  /** Number of files remaining in the queue (including the current one) */
  remaining: number;
};

type UseUploadOptions = {
  currentPath: string;
  includeStats: boolean;
};

export function useUpload({ currentPath, includeStats }: UseUploadOptions) {
  const [state, setState] = useState<UploadState>({
    isUploading: false,
    progress: 0,
    fileName: null,
    remaining: 0,
  });

  const uploadRef = useRef<tus.Upload | null>(null);
  const queueRef = useRef<File[]>([]);
  const processingRef = useRef(false);
  const processNextRef = useRef<() => void>(() => {});

  const invalidateQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["files.list", currentPath, includeStats] });
    queryClient.invalidateQueries({ queryKey: ["files.storage"] });
  }, [currentPath, includeStats]);

  const processNext = useCallback(() => {
    if (queueRef.current.length === 0) {
      processingRef.current = false;
      uploadRef.current = null;
      setState({ isUploading: false, progress: 0, fileName: null, remaining: 0 });
      return;
    }

    const file = queueRef.current[0];
    const remaining = queueRef.current.length;
    setState({ isUploading: true, progress: 0, fileName: file.name, remaining });

    const upload = new tus.Upload(file, {
      endpoint: "/api/upload",
      retryDelays: [0, 1000, 3000, 5000],
      metadata: {
        filename: file.name,
        filetype: file.type,
        targetPath: currentPath || "",
      },
      onProgress(bytesUploaded, bytesTotal) {
        const pct = Math.round((bytesUploaded / bytesTotal) * 100);
        setState((prev) => ({ ...prev, progress: pct }));
      },
      onSuccess() {
        toast.success(`Uploaded "${file.name}"`);
        invalidateQueries();
        // Remove completed file from queue and process next
        queueRef.current.shift();
        processNextRef.current();
      },
      onError(error) {
        toast.error(`Upload failed for "${file.name}": ${error.message}`);
        // Remove failed file from queue and continue with next
        queueRef.current.shift();
        processNextRef.current();
      },
    });

    uploadRef.current = upload;

    upload.findPreviousUploads().then((previousUploads) => {
      if (previousUploads.length > 0) {
        upload.resumeFromPreviousUpload(previousUploads[0]);
      }
      upload.start();
    });
  }, [currentPath, invalidateQueries]);

  useEffect(() => {
    processNextRef.current = processNext;
  }, [processNext]);

  const uploadFiles = useCallback(
    (files: File[]) => {
      queueRef.current.push(...files);

      // If not already processing, start the queue
      if (!processingRef.current) {
        processingRef.current = true;
        processNext();
      } else {
        // Update remaining count for the UI
        setState((prev) => ({ ...prev, remaining: queueRef.current.length }));
      }
    },
    [processNext],
  );

  const cancelUpload = useCallback(() => {
    if (uploadRef.current) {
      uploadRef.current.abort();
    }
    uploadRef.current = null;
    queueRef.current = [];
    processingRef.current = false;
    setState({ isUploading: false, progress: 0, fileName: null, remaining: 0 });
    toast("Upload cancelled");
  }, []);

  return {
    ...state,
    uploadFiles,
    cancelUpload,
  };
}
