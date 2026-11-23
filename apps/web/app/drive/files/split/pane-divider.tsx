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
 * `min` and `max`; it catches at the middle, and a double-click returns it there. Its buttons
 * fold either pane away.
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
  return (
    <div className="relative z-30 w-3 shrink-0">
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
        data-dragging={live === null ? undefined : true}
        className="group absolute inset-y-0 -inset-x-1 cursor-col-resize touch-none outline-none pointer-coarse:-inset-x-3"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={() => commit(middle)}
        onKeyDown={onKeyDown}
      >
        <div
          className={cn(
            "mx-auto h-full w-px bg-border transition-colors",
            "group-hover:w-0.5 group-hover:bg-primary/50 group-focus-visible:w-0.5 group-focus-visible:bg-primary group-data-dragging:w-0.5 group-data-dragging:bg-primary",
          )}
        />
      </div>
      {/* Level with the panes' toolbars, clear of the bar people drag and double-click. */}
      <div className="absolute left-1/2 top-2.5 flex -translate-x-1/2 flex-col gap-0.5">
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Collapse left pane"
          title="Collapse left pane"
          className="touch-hit rounded-full bg-background shadow-sm"
          onClick={() => collapse("left")}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Collapse right pane"
          title="Collapse right pane"
          className="touch-hit rounded-full bg-background shadow-sm"
          onClick={() => collapse("right")}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
