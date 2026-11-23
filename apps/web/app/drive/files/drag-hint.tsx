import { cn } from "@/lib/utils";
import { DropTarget } from "./drop-target";
import type { FileDrag } from "./use-file-drag";

/**
 * Says where a drag would put things, or why it cannot, while it is over a folder: shown near the
 * bottom of the window, or of a split view's pane (`placement`), and announced to screen readers.
 * The region stays mounted so each change is read; a pane's says nothing while the drag is over
 * the other pane (`shown`).
 */
export function DragHint({
  drag,
  placement = "window",
  shown = true,
}: {
  drag: FileDrag;
  placement?: "window" | "pane";
  shown?: boolean;
}) {
  const { over } = drag;
  const payload = drag.state.status === "dragging" ? drag.state.payload : null;
  const behind =
    payload?.kind === "entries"
      ? DropTarget.leftBehind({
          dragged: payload.sources.length,
          skipped: payload.skipped,
        })
      : null;
  const staying =
    payload?.kind === "entries" && over?.verdict.kind === "move"
      ? DropTarget.alreadyThere(payload.sources, over.target)
      : null;
  const text = !shown
    ? ""
    : [over && DropTarget.hint(over.verdict, over.target), staying, behind]
        .filter(Boolean)
        .join(". ");
  return (
    <p
      role="status"
      className={cn(
        "pointer-events-none left-1/2 z-50 -translate-x-1/2 truncate rounded-full px-4 py-2 text-sm font-medium shadow-md",
        placement === "pane"
          ? "absolute bottom-6 max-w-[calc(100%-2rem)]"
          : "fixed bottom-[calc(max(1.5rem,env(safe-area-inset-bottom))+var(--impersonation-offset,0px))] max-w-[calc(100vw-2rem)]",
        !text && "sr-only",
        over?.verdict.kind === "refused"
          ? "bg-popover text-popover-foreground ring-1 ring-destructive/60"
          : "bg-primary text-primary-foreground",
      )}
    >
      {text}
    </p>
  );
}
