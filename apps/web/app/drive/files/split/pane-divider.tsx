import { GripVertical } from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";

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
 * between the two pane cards, with a dotted grip in its middle. Folding a pane away is the pane's
 * own (see `PaneTools`); a folded pane opens again from its strip (see `CollapsedPane`).
 */
export function PaneDivider({
  ratio,
  min,
  max,
  frameRef,
  controls,
  preview,
  commit,
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
    <div className="relative z-30 shrink-0">
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
        // 16 px to grab with a mouse, 44 px on touch, however thin what is drawn.
        className="group absolute inset-y-0 -inset-x-1 cursor-col-resize touch-none outline-none pointer-coarse:-inset-x-[18px]"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={() => commit(middle)}
        onKeyDown={onKeyDown}
      >
        {/* A raised chip with a dotted grip, as resizable handles are drawn: hidden at rest, it
            shows when pointed at, focused (with its ring) or dragged (in the accent colour),
            and always on touch screens, which cannot point. Slightly wider than the gap, so it
            sits over the cards' edges. */}
        <div
          className={cn(
            "absolute left-1/2 top-1/2 flex h-8 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border bg-card text-muted-foreground shadow-sm transition-opacity duration-150 motion-reduce:transition-none",
            "opacity-0 group-hover:opacity-100 pointer-coarse:h-10 pointer-coarse:w-6 pointer-coarse:opacity-100",
            "group-focus-visible:opacity-100 group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-1 group-focus-visible:ring-offset-background",
            "group-data-dragging:border-primary group-data-dragging:bg-primary group-data-dragging:text-primary-foreground group-data-dragging:opacity-100",
          )}
        >
          <GripVertical className="size-4 pointer-coarse:size-5" />
        </div>
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
