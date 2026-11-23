import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PaneSide } from "../split-layout";

/** The middle catches the divider this close, in pixels, while it is dragged. */
const snapPx = 16;
const step = 2;
const largeStep = 10;
const middle = 50;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * The bar between the panes of a split view, as a window splitter: drag it, or focus it and
 * use the arrow keys (Shift for larger steps), Home and End, to share the width out within
 * `min` and `max`; it catches at the middle, and a double-click returns it there. It is the gap
 * between the two pane cards, with a handle on hover or focus whose buttons fold either pane away.
 */
export function PaneDivider({
  ratio,
  min,
  max,
  frameRef,
  controls,
  preview,
  commit,
  collapse,
}: {
  /** The left pane's share of the width in percent. */
  ratio: number;
  min: number;
  max: number;
  /** The panes' container, whose width the ratio divides. */
  frameRef: RefObject<HTMLElement | null>;
  /** The id of the left pane, which the divider sizes. */
  controls: string;
  /** Shows a ratio while dragging, without remembering it. */
  preview: (ratio: number) => void;
  /** Keeps a ratio: in the address and for this browser. */
  commit: (ratio: number) => void;
  collapse: (side: PaneSide) => void;
}) {
  const [live, setLive] = useState<number | null>(null);
  // The drag's ratio as of the last event: the release and the capture's loss both end it.
  const dragged = useRef<number | null>(null);
  const shown = live ?? ratio;

  const ratioAt = (clientX: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return shown;
    const raw = ((clientX - rect.left) / rect.width) * 100;
    const near = (Math.abs(raw - middle) * rect.width) / 100 <= snapPx;
    return clamp(near ? middle : raw, min, max);
  };
  const end = () => {
    const last = dragged.current;
    if (last === null) return;
    dragged.current = null;
    setLive(null);
    commit(Math.round(last));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragged.current = shown;
    setLive(shown);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragged.current === null) return;
    const next = ratioAt(event.clientX);
    dragged.current = next;
    setLive(next);
    preview(next);
  };

  /** One keyboard step from the current ratio, stopping at the middle on the way past. */
  const stepBy = (delta: number) => {
    const next = shown + delta;
    const passes =
      (shown < middle && next > middle) || (shown > middle && next < middle);
    return clamp(passes ? middle : next, min, max);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const amount = event.shiftKey ? largeStep : step;
    const next =
      event.key === "ArrowLeft"
        ? stepBy(-amount)
        : event.key === "ArrowRight"
          ? stepBy(amount)
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : null;
    if (next === null || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    commit(Math.round(next));
  };

  const value = Math.round(shown);
  const dragging = live !== null;
  return (
    <div className="group/divider relative z-30 shrink-0">
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize panes"
        aria-orientation="vertical"
        aria-controls={controls}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`Left pane ${value}%, right pane ${100 - value}%`}
        data-dragging={dragging ? true : undefined}
        className="group absolute inset-y-0 -inset-x-1 cursor-col-resize touch-none outline-none pointer-coarse:-inset-x-3"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={() => commit(middle)}
        onKeyDown={onKeyDown}
      >
        {/* The gap itself is the divider: empty at rest, a line when pointed at, focused or dragged. */}
        <div
          className={cn(
            "absolute inset-y-3 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-transparent transition-colors duration-150 motion-reduce:transition-none",
            "group-hover:bg-foreground/15 group-focus-visible:bg-ring group-data-dragging:bg-primary",
          )}
        />
      </div>
      {/* Folds either pane away: shown on hover or focus, out of the way of a drag. The middle
          lets the drag through, so the handle can be held like the gap around it. */}
      <div
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-full border bg-popover p-0.5 shadow-sm transition-opacity duration-150 motion-reduce:transition-none",
          dragging
            ? "opacity-0"
            : "opacity-0 group-hover/divider:opacity-100 group-has-[:focus-visible]/divider:opacity-100",
        )}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Collapse left pane"
          title="Collapse left pane"
          className="touch-hit pointer-events-auto rounded-full"
          onClick={() => collapse("left")}
        >
          <ChevronLeft />
        </Button>
        <span
          aria-hidden
          className="h-3 w-0.5 rounded-full bg-muted-foreground/40"
        />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Collapse right pane"
          title="Collapse right pane"
          className="touch-hit pointer-events-auto rounded-full"
          onClick={() => collapse("right")}
        >
          <ChevronRight />
        </Button>
      </div>
      {/* While dragging, says when the divider has caught at the middle. */}
      {dragging && value === middle && (
        <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-[3.75rem] whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs font-medium tabular-nums text-background shadow-sm">
          50 / 50
        </span>
      )}
    </div>
  );
}
