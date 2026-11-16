import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { FilePreviewProps } from "./preview/file-preview";
import type { PreviewDialogProps } from "./preview/preview-dialog-body";

// Nothing about previews loads until one opens: the dialog, then the renderer
// for that file's kind, are separate chunks.
const DialogBody = lazy(() => import("./preview/preview-dialog-body"));
const PreviewBody = lazy(() => import("./preview/file-preview"));

export type { FilePreviewProps, PreviewDialogProps };

export function PreviewDialog(props: PreviewDialogProps) {
  return (
    <Suspense fallback={null}>
      <DialogBody {...props} />
    </Suspense>
  );
}

export function FilePreview(props: FilePreviewProps) {
  return (
    <Suspense
      fallback={
        <Skeleton
          aria-label="Loading preview"
          className="h-[min(65dvh,32rem)] w-full"
        />
      }
    >
      <PreviewBody {...props} />
    </Suspense>
  );
}
