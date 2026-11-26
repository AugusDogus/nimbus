import { useQuery } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { BreadcrumbTrail } from "../breadcrumb-trail";
import { FileBreadcrumbs } from "../breadcrumbs";
import { FolderCard } from "../folder-card";
import { NavPlace } from "../nav-place";
import type { PaneSide } from "../split-layout";
import { ActivePane } from "./active-pane";
import { paneCard } from "./pane-section";
import { SwipePanes } from "./swipe-panes";

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
  tint,
}: {
  side: PaneSide;
  name: string;
  onShow: () => void;
  /** The tint's strength from the start, for a pane that comes in wholly out of view. */
  tint?: number;
}) {
  return (
    <>
      <span
        aria-hidden
        data-depth-tint={side}
        style={tint === undefined ? undefined : { opacity: tint }}
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
 * A pane coming in as a person opens a split, one pane at a time: the card the pane will be, its
 * header and path as the pane draws them and its listing still empty, a step back like any pane
 * out of view. It stands in while the split's opening moves, so that motion starts at once, and
 * gives way to the pane itself once in place. Only the edge of it nearest the window's side ever
 * shows, where the pane draws the same: its card, its path's first folder, and the listing's
 * margin.
 */
export function EnteringPane({ side, path }: { side: PaneSide; path: string }) {
  const top = useQuery(trpc.access.me.queryOptions()).data?.top ?? "";
  const trail = BreadcrumbTrail.of(path, top, NavPlace.labels.files);
  const name = trail.crumbs.at(-1)?.label ?? trail.root.label;
  return (
    <FolderCard
      pane={{
        id: undefined,
        side,
        card: (active) => paneCard(side, active, false, "swipe"),
        handlers: {},
        hint: (
          <PaneDepth
            side={side}
            name={name}
            onShow={() => ActivePane.set(side)}
            tint={SwipePanes.back.tint}
          />
        ),
      }}
      attachToolbar={() => undefined}
      moves={{ back: null, up: null }}
      breadcrumbs={<FileBreadcrumbs trail={trail} folded />}
      tools={null}
      body={null}
    />
  );
}
