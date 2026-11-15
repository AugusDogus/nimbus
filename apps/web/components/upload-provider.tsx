"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useUploadQueue } from "@/lib/use-upload-queue";
import { UploadConflictDialog } from "./upload-conflict-dialog";

const UploadContext = createContext<ReturnType<typeof useUploadQueue> | null>(
  null,
);

/**
 * Owns the upload queue for the whole app, so uploads continue across navigation. Progress is
 * read from the queue's store by the components that show it, not through this context.
 */
export function UploadProvider({ children }: { children: ReactNode }) {
  const upload = useUploadQueue();
  return (
    <UploadContext.Provider value={upload}>
      {children}
      <UploadConflictDialog prompt={upload.prompt} />
    </UploadContext.Provider>
  );
}

export function useUploads() {
  const upload = useContext(UploadContext);
  if (!upload)
    throw new Error("Upload controls must be rendered inside UploadProvider.");
  return upload;
}
