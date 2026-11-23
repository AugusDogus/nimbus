import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { entryGeometry } from "./entry-layout";
import { EntryShape } from "./entry-shape";
import { useGridTrack } from "./use-grid-track";

const bar = "motion-reduce:animate-none";

/** How many placeholder entries a listing shows: more than fit, so the listing looks full. */
const placeholders = { list: 12, grid: 18 } as const;

/**
 * The listing's grid without JavaScript, so the page's skeleton can lay it out before the app
 * runs: as many columns as fit at `minWidth`, each card `aspect` of its width in height, rounded
 * to the pixel as `EntryLayout.gridTrack` rounds it. In the app the listing's own track sets the
 * cards' height instead, as it does the listing's, so a card half a pixel off a whole height
 * rounds the same way in both.
 */
const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: `repeat(auto-fill, minmax(${entryGeometry.grid.minWidth}px, 1fr))`,
  gap: entryGeometry.grid.gap,
};
const cardCell: CSSProperties = { containerType: "inline-size" };
const card: CSSProperties = {
  height: `round(nearest, calc(100cqw * ${entryGeometry.grid.aspect}), 1px)`,
};

/**
 * A listing before it arrives: a section title, where it has one, and placeholder entries, each
 * where the listing will put its own. It takes its shape from `EntryShape` and its sizes from
 * `entryGeometry`, as the listing does.
 */
export function EntrySkeleton({
  view,
  titled = true,
  grid: track,
}: {
  view: "list" | "grid";
  /** Whether the listing's first section has a title, as a folder's does. */
  titled?: boolean;
  /** In the app: the grid's element, to measure, and its cards' height once measured. */
  grid?: { ref: Ref<HTMLDivElement>; cardHeight: number };
}) {
  return (
    <div aria-hidden data-entry-skeleton={view}>
      {titled && (
        <div
          data-shape="section-title"
          style={{
            height: entryGeometry.header.height,
            marginBottom: entryGeometry.header.gap,
          }}
          className={cn(EntryShape.title, "flex items-center")}
        >
          <Skeleton className={cn("h-3 w-12", bar)} />
        </div>
      )}
      {view === "list" ? (
        <div className="flex flex-col" style={{ gap: entryGeometry.list.gap }}>
          {Array.from({ length: placeholders.list }, (_, index) => (
            <div
              key={index}
              data-entry-placeholder
              className="relative"
              style={{ height: entryGeometry.list.height }}
            >
              <div className={cn(EntryShape.entry, EntryShape.listRow)}>
                <span className={EntryShape.listIcon}>
                  <Skeleton className={cn("size-5 rounded", bar)} />
                </span>
                <Skeleton className={cn("h-4 w-full max-w-64", bar)} />
              </div>
              <Skeleton
                className={cn(
                  EntryShape.actions,
                  "size-8 md:pointer-fine:invisible",
                  bar,
                )}
              />
            </div>
          ))}
        </div>
      ) : (
        <div ref={track?.ref} style={grid}>
          {Array.from({ length: placeholders.grid }, (_, index) => (
            <div key={index} style={cardCell}>
              <div
                data-entry-placeholder
                style={track ? { height: track.cardHeight } : card}
                className={cn(EntryShape.entry, EntryShape.card, "bg-muted/30")}
              >
                <div
                  className={cn(
                    EntryShape.cardPicture,
                    "flex items-center justify-center",
                  )}
                >
                  <Skeleton className={cn("size-10 rounded", bar)} />
                </div>
                <div className={EntryShape.cardName}>
                  <Skeleton className={cn("h-3.5 w-3/4", bar)} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The placeholder listing while a folder's listing loads in the app, after `delayMs`, so a
 * listing that arrives quickly never flashes it.
 */
export function LoadingSkeleton({
  view,
  delayMs = 0,
}: {
  view: "list" | "grid";
  delayMs?: number;
}) {
  const [due, setDue] = useState(delayMs === 0);
  useEffect(() => {
    if (due) return;
    const timer = setTimeout(() => setDue(true), delayMs);
    return () => clearTimeout(timer);
  }, [due, delayMs]);
  return due ? <MeasuredEntrySkeleton view={view} /> : null;
}

/** The skeleton in the app, its grid measured as the listing's is (see `useGridTrack`). */
function MeasuredEntrySkeleton({ view }: { view: "list" | "grid" }) {
  const ref = useRef<HTMLDivElement>(null);
  const track = useGridTrack(ref, view === "grid");
  return <EntrySkeleton view={view} grid={{ ref, cardHeight: track.height }} />;
}
