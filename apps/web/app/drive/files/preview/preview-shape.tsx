import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The boxes a preview fills, loaded or loading. The stage is one size for every kind of file and
 * whatever the file's own size: media fit inside it, and text, PDFs and notes fill it and scroll
 * on their own. The dialog around it so keeps its size from the moment it opens, through the
 * media loading, and from one file to the next.
 *
 * A text preview fills the stage with a frame, and below it a row for the preview's notes and
 * actions, of at least a button's height.
 */
export const PreviewShape = {
  stage: "flex h-[min(65dvh,40rem)] w-full min-w-0 flex-col gap-2",
  frame: "min-h-0 w-full flex-1 overflow-auto rounded-md border bg-muted",
  actions:
    "flex min-h-8 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground",
} as const;

/** A text preview's frame and row while its code or text loads, inside the stage. */
export function TextFrameLoading() {
  return (
    <>
      <Skeleton
        aria-label="Loading preview"
        className={cn(
          PreviewShape.frame,
          "border-transparent motion-reduce:animate-none",
        )}
      />
      <div aria-hidden className={PreviewShape.actions} />
    </>
  );
}

/** A preview while its code loads, in the stage it will fill. */
export function TextPreviewLoading() {
  return (
    <div data-preview-stage className={PreviewShape.stage}>
      <TextFrameLoading />
    </div>
  );
}
