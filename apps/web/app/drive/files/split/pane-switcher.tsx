import { PanelLeft, PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { PaneSide } from "../split-layout";
import { ActivePane } from "./active-pane";

const sides = [
  { side: "left", name: "Left", Icon: PanelLeft },
  { side: "right", name: "Right", Icon: PanelRight },
] as const;

/** The scroll timeline the frame gives the switcher's thumb, where the browser has them. */
const timeline = "--panes";
const scrollTimelines =
  typeof CSS !== "undefined" && CSS.supports("animation-timeline", timeline);

/**
 * Keeps `thumb` over the pane the frame shows, as far as it has scrolled: by the browser's own
 * scroll timeline where it has one, which runs off the main thread, otherwise by a passive scroll
 * listener that only moves the thumb.
 */
function useThumb(frame: HTMLElement | null, thumb: HTMLElement | null): void {
  useEffect(() => {
    if (!frame || !thumb) return;
    if (scrollTimelines) {
      const scope = frame.parentElement;
      frame.style.setProperty("scroll-timeline", `${timeline} x`);
      scope?.style.setProperty("timeline-scope", timeline);
      return () => {
        frame.style.removeProperty("scroll-timeline");
        scope?.style.removeProperty("timeline-scope");
      };
    }
    const place = () => {
      const range = frame.scrollWidth - frame.clientWidth;
      const progress = range > 0 ? frame.scrollLeft / range : 0;
      thumb.style.setProperty(
        "transform",
        `translateX(calc(${progress} * (100% + 0.25rem)))`,
      );
    };
    place();
    frame.addEventListener("scroll", place, { passive: true });
    return () => frame.removeEventListener("scroll", place);
  }, [frame, thumb]);
}

/**
 * Where two panes do not fit side by side: which pane shows, named by its folder, and the other
 * one a tap away. A swipe across the panes does the same. Its thumb follows the frame as a finger
 * moves it, so it is always over what the window shows; the names take the active pane's colour
 * once a swipe lands or a tap chooses.
 */
export function PaneSwitcher({
  labels,
  frame,
}: {
  labels: Record<PaneSide, string>;
  /** The frame the panes scroll in, which the thumb follows. */
  frame: HTMLElement | null;
}) {
  const active = ActivePane.use() ?? "left";
  const [thumb, setThumb] = useState<HTMLSpanElement | null>(null);
  useThumb(frame, thumb);
  return (
    <ToggleGroup
      aria-label="Panes"
      value={[active]}
      onValueChange={([value]) => {
        if (value === "left" || value === "right") ActivePane.set(value);
      }}
      data-shape="pane-switcher"
      variant="default"
      size="sm"
      spacing={1}
      className="relative mb-3 grid w-full shrink-0 grid-cols-2 rounded-lg bg-muted/70 p-1 md:mx-2 md:mt-2 md:mb-2 md:w-auto"
    >
      <span
        ref={setThumb}
        aria-hidden
        className="pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-0.375rem)] rounded-md bg-card shadow-sm dark:bg-accent"
        style={
          scrollTimelines
            ? {
                animation: "pane-thumb linear both",
                animationTimeline: timeline,
              }
            : undefined
        }
      />
      {sides.map(({ side, name, Icon }) => (
        <ToggleGroupItem
          key={side}
          value={side}
          aria-label={`${name} pane: ${labels[side]}`}
          className="relative h-9 min-w-0 justify-start gap-2 rounded-md px-3 text-muted-foreground pointer-coarse:h-11 data-pressed:bg-transparent data-pressed:text-foreground"
        >
          <Icon className="size-4 shrink-0" />
          <span className="truncate text-sm">{labels[side]}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
