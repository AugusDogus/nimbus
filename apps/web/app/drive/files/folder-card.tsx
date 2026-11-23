import { ArrowLeft, ArrowUp } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { PageSurface } from "@/components/page-surface";
import { cn } from "@/lib/utils";
import type { PaneSide } from "./split-layout";

/** Where a folder's Back and Up go; null where there is nowhere to go. */
export type FolderMoves = {
  back: (() => void) | null;
  up: (() => void) | null;
};

/** How a pane draws its card, its header row and its listing; they load with the split view. */
export type FolderCardClasses = {
  section: string;
  header: string;
  body: string;
};

/** What makes a folder's card a pane of a split view. */
export type FolderCardPane = {
  id: string;
  side: PaneSide;
  /** Names the pane, and says whether it is the active one. */
  label: string;
  /** The pane New, Upload and the page's commands act on. */
  active: boolean;
  classes: FolderCardClasses;
  /** The pane's own pointer, focus and drop handlers. */
  handlers: HTMLAttributes<HTMLElement>;
  /** Says where a drag over the pane would drop. */
  hint: ReactNode;
};

/**
 * A folder on its card: a header row of Back, Up, the folder's path and its tools, then the
 * listing, which scrolls on its own below the header. The page's one folder and each pane of a
 * split view use the same card, element for element, so opening or closing the split keeps the
 * first folder's listing, selection and scroll position as they are. On phones the header row
 * sticks below the page header and the page itself scrolls.
 */
export function FolderCard({
  pane,
  attachToolbar,
  moves,
  breadcrumbs,
  tools,
  body,
}: {
  pane: FolderCardPane | null;
  attachToolbar: (element: HTMLDivElement | null) => void;
  moves: FolderMoves;
  breadcrumbs: ReactNode;
  /** After the path: sort and view for the page's folder; a menu and Close for a pane. */
  tools: ReactNode;
  body: ReactNode;
}) {
  return (
    <section
      data-slot="folder-card"
      id={pane?.id}
      data-pane={pane?.side}
      data-active={pane?.active ? true : undefined}
      aria-label={pane?.label}
      aria-current={pane?.active ? "true" : undefined}
      {...pane?.handlers}
      className={cn(
        "relative transition-[background-color,box-shadow] duration-150 ease-out motion-reduce:transition-none",
        pane
          ? pane.classes.section
          : cn(
              "md:flex md:min-h-0 md:min-w-0 md:flex-1 md:flex-col md:overflow-hidden",
              PageSurface.raisedFromTablet,
            ),
      )}
    >
      <div
        ref={attachToolbar}
        className={cn(
          // The selection bar covers this row and takes its colour (`bg-inherit`), so it is solid.
          "z-10 items-center gap-1 border-b",
          pane
            ? pane.classes.header
            : "surface-grain sticky top-16 -mx-4 -mt-6 mb-6 grid grid-cols-[minmax(0,1fr)_auto] border-border/70 bg-background px-4 py-3 md:relative md:top-auto md:m-0 md:flex md:h-14 md:shrink-0 md:border-border/60 md:bg-card md:bg-none md:px-2 md:py-0",
        )}
      >
        <div
          className={cn("flex shrink-0 items-center", !pane && "max-md:hidden")}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            title="Back"
            disabled={!moves.back}
            onClick={() => moves.back?.()}
            className="touch-hit shrink-0"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Up one level"
            title="Up one level"
            disabled={!moves.up}
            onClick={() => moves.up?.()}
            className="touch-hit mr-1 shrink-0"
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
        <div
          className={cn(
            "min-w-0 overflow-hidden md:flex-1",
            pane
              ? "flex-1"
              : "pointer-coarse:-my-3 pointer-coarse:py-3 pointer-coarse:-ml-3.5 pointer-coarse:pl-3.5",
          )}
        >
          {breadcrumbs}
        </div>
        {tools}
      </div>
      <div
        data-slot="folder-list"
        className={cn(
          "overflow-x-clip",
          pane
            ? pane.classes.body
            : "md:min-h-0 md:flex-1 md:overflow-y-auto md:p-4 md:[scrollbar-gutter:stable]",
        )}
      >
        {body}
      </div>
      {pane?.hint}
    </section>
  );
}
