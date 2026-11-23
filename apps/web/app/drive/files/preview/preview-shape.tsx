import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The boxes a text preview fills, loaded or loading: a frame of one height whatever the text,
 * which scrolls on its own, and below it a row for the preview's notes and actions, of at least
 * a button's height. The dialog around it so keeps its size from the moment it opens, and from
 * one file to the next.
 */
export const PreviewShape = {
  text: "space-y-2",
  frame: "h-[min(65dvh,32rem)] w-full overflow-auto rounded-md border bg-muted",
  actions:
    "flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground",
} as const;

/** A text preview while its code or text loads, in the boxes it will fill. */
export function TextPreviewLoading() {
  return (
    <div className={PreviewShape.text}>
      <Skeleton
        aria-label="Loading preview"
        className={cn(
          PreviewShape.frame,
          "border-transparent motion-reduce:animate-none",
        )}
      />
      <div aria-hidden className={PreviewShape.actions} />
    </div>
  );
}
