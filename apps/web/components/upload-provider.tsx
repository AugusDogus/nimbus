"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useUploadQueue } from "@/lib/use-upload-queue";

const UploadContext = createContext<ReturnType<typeof useUploadQueue> | null>(
  null,
);

export function UploadProvider({ children }: { children: ReactNode }) {
  const upload = useUploadQueue();
  return (
    <UploadContext.Provider value={upload}>{children}</UploadContext.Provider>
  );
}

export function useUploads() {
  const upload = useContext(UploadContext);
  if (!upload)
    throw new Error("Upload controls must be rendered inside UploadProvider.");
  return upload;
}
