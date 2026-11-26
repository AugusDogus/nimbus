import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PaneSide } from "../split-layout";

/**
 * A phone's split view shows one pane and the other's edge, 56 px of it. That edge names its
 * folder, written down the strip with its count of items, and a chevron points to it; a tap there
 * brings that pane into view. The left pane's edge is its right one, the right pane's its left.
 *
 * It shows only as far as its pane is out of view: its opacity, and whether it takes a press or
 * focus, follow the frame's scroll position (see `useSwipePanes`), set on the element itself
 * rather than through React, so a swipe renders nothing.
 */
export function EdgeLabel({
  side,
  name,
  count,
  onShow,
}: {
  side: PaneSide;
  name: string;
  count: number | null;
  onShow: () => void;
}) {
  const atEnd = side === "left";
  return (
    <button
      type="button"
      data-edge-label={side}
      aria-label={`Show ${name}`}
      onClick={onShow}
      className={cn(
        "pointer-events-none absolute inset-y-0 z-30 flex w-14 flex-col items-center justify-center gap-2.5 border-border bg-card text-muted-foreground opacity-0 outline-none will-change-[opacity] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        atEnd ? "right-0 border-l" : "left-0 border-r",
      )}
    >
      {atEnd ? (
        <ChevronLeft aria-hidden className="size-4 shrink-0" />
      ) : (
        <ChevronRight aria-hidden className="size-4 shrink-0" />
      )}
      {/* Read from the strip's outer side: the right pane's name turns to face its own edge. */}
      <span
        className={cn(
          "max-h-[50%] truncate text-sm font-semibold text-foreground [writing-mode:vertical-rl]",
          !atEnd && "rotate-180",
        )}
      >
        {name}
      </span>
      {count !== null && (
        <span
          className={cn(
            "text-xs tabular-nums [writing-mode:vertical-rl]",
            !atEnd && "rotate-180",
          )}
        >
          {count.toLocaleString()} {count === 1 ? "item" : "items"}
        </span>
      )}
    </button>
  );
}
