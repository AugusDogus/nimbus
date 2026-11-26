import { cn } from "@/lib/utils";
import { EntrySkeleton } from "../loading-skeleton";
import type { PaneSide } from "../split-layout";
import { ActivePane } from "./active-pane";
import { paneCard } from "./pane-section";

/**
 * A phone's split view shows one pane and, about 32 px of it, the other, which sits a step back:
 * smaller and dimmed with the page's tint, the further the more it is out of view. Over it lies
 * one button the size of the pane, so a tap anywhere on it brings that pane into view.
 *
 * How far back the pane sits, the tint's strength, and whether the button takes a press or focus
 * all follow the frame's scroll position (see `useSwipePanes`), set on the elements themselves
 * rather than through React, so a swipe renders nothing.
 */
export function PaneDepth({
  side,
  name,
  onShow,
}: {
  side: PaneSide;
  name: string;
  onShow: () => void;
}) {
  return (
    <>
      <span
        aria-hidden
        data-depth-tint={side}
        className="pointer-events-none absolute inset-0 z-20 bg-background opacity-0 will-change-[opacity]"
      />
      <button
        type="button"
        data-depth-show={side}
        aria-label={`Show ${name}`}
        onClick={onShow}
        className="pointer-events-none absolute inset-0 z-30 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      />
    </>
  );
}

/**
 * A pane coming in as a person opens a split, one pane at a time: its card as it will be, with its
 * folder's name in the header and placeholder rows, a step back like any pane out of view. It
 * stands in while the split's opening moves, so that motion starts at once, and gives way to the
 * pane itself once in place.
 */
export function EnteringPane({
  side,
  name,
  view,
}: {
  side: PaneSide;
  name: string;
  view: "list" | "grid";
}) {
  const { classes } = paneCard(side, false, false, "swipe");
  return (
    <section data-pane={side} className={cn("relative", classes.section)}>
      <div className={cn("z-10 items-center gap-1 border-b", classes.header)}>
        <span className="min-w-0 truncate px-2 text-sm font-medium">
          {name}
        </span>
      </div>
      <div data-slot="folder-list" className={classes.body}>
        <EntrySkeleton view={view} />
      </div>
      <PaneDepth side={side} name={name} onShow={() => ActivePane.set(side)} />
    </section>
  );
}
