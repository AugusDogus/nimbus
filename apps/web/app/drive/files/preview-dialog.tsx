import { lazyComponent } from "@/components/lazy-component";
import { Skeleton } from "@/components/ui/skeleton";
import type { FilePreviewProps } from "./preview/file-preview";
import type { PreviewDialogProps } from "./preview/preview-dialog-body";

export type { FilePreviewProps, PreviewDialogProps };

// Nothing about previews loads until one opens: the dialog, then the renderer
// for that file's kind, are separate chunks.
export const PreviewDialog = lazyComponent<PreviewDialogProps>(
  () => import("./preview/preview-dialog-body"),
);

export const FilePreview = lazyComponent<FilePreviewProps>(
  () => import("./preview/file-preview"),
  <Skeleton
    aria-label="Loading preview"
    className="h-[min(65dvh,32rem)] w-full"
  />,
);
