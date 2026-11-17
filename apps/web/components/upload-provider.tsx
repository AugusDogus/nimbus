import { lazyComponent } from "@/components/lazy-component";
import { createContext, useContext, type ReactNode } from "react";
import { useFileDropGuard } from "@/lib/use-file-drop-guard";
import { useUploadQueue } from "@/lib/use-upload-queue";

// Only needed when an upload's name is taken; it loads then, not with every page.
const UploadConflictDialog = lazyComponent(async () => ({
  default: (await import("./upload-conflict-dialog")).UploadConflictDialog,
}));

const UploadContext = createContext<ReturnType<typeof useUploadQueue> | null>(
  null,
);

/**
 * Owns the upload queue for the whole app, so uploads continue across navigation. Progress is
 * read from the queue's store by the components that show it, not through this context.
 */
export function UploadProvider({ children }: { children: ReactNode }) {
  const upload = useUploadQueue();
  useFileDropGuard();
  return (
    <UploadContext.Provider value={upload}>
      {children}
      {upload.prompt && <UploadConflictDialog prompt={upload.prompt} />}
    </UploadContext.Provider>
  );
}

export function useUploads() {
  const upload = useContext(UploadContext);
  if (!upload)
    throw new Error("Upload controls must be rendered inside UploadProvider.");
  return upload;
}
