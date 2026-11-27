import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ArrowUp } from "lucide-react";
import {
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "@/components/ui/button";
import { PageSurface } from "@/components/page-surface";
import { cn } from "@/lib/utils";
import type { PaneSide } from "./split-layout";
import { SplitRoom } from "./split-room";
import { ActivePane } from "./split/active-pane";

/** Where a folder's Back and Up go; null where there is nowhere to go. */
export type FolderMoves = {
  back: (() => void) | null;
  up: (() => void) | null;
};

/**
 * The moves of a page that lists items from many folders, such as Recent or Trash: Back, and no
 * Up, as at the drive's root, so its title sits where a folder's path does.
 */
export function useBackOnly(): FolderMoves {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  return { back: canGoBack ? () => router.history.back() : null, up: null };
}

/**
 * The card's header row, for the selection bar to cover (`selectionSlot`) and for the listing to
 * keep the entry it moves to clear of (`toolbarRef`); `attach` takes the row (`attachToolbar`).
 */
export function useToolbarSlot(): {
  toolbarRef: RefObject<HTMLDivElement | null>;
  selectionSlot: HTMLDivElement | null;
  attach: (element: HTMLDivElement | null) => void;
} {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [selectionSlot, setSelectionSlot] = useState<HTMLDivElement | null>(
    null,
  );
  const attach = (element: HTMLDivElement | null) => {
    toolbarRef.current = element;
    setSelectionSlot(element);
  };
  return { toolbarRef, selectionSlot, attach };
}

/** How a pane draws its card, its header row and its listing; they load with the split view. */
export type FolderCardClasses = {
  section: string;
  /** Back and Up, before the path. */
  moves: string;
  header: string;
  body: string;
};

/** What makes a folder's card a pane of a split view. */
export type FolderCardPane = {
  /** The pane's element id, for what controls it; none for a card standing in for one. */
  id: string | undefined;
  side: PaneSide;
  /**
   * The pane's name and look, active or not. The active pane, the one New, Upload and the page's
   * commands act on, is read here (see `ActivePane`), so switching panes redraws the card and
   * not the listing inside it.
   */
  card: (active: boolean) => { label: string; classes: FolderCardClasses };
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
 * sticks below the page header and the page itself scrolls. Every other files page, such as
 * Recent, Shared, Trash or a search, uses the card too, its title where the path goes.
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
  /** The folder's path, or another page's title (`PageLayout.cardTitle`). */
  breadcrumbs: ReactNode;
  /**
   * After the path: sort and view for the page's folder, or another page's, with any of its own
   * tools after them, such as Trash's Empty trash; a menu and Close for a pane.
   */
  tools: ReactNode;
  body: ReactNode;
}) {
  const active = ActivePane.useIs(pane?.side ?? null);
  const look = pane?.card(active);
  return (
    <section
      data-slot="folder-card"
      id={pane?.id}
      data-pane={pane?.side}
      data-active={active ? true : undefined}
      aria-label={look?.label}
      aria-current={active ? "true" : undefined}
      {...pane?.handlers}
      className={cn(
        "group/pane relative",
        look
          ? look.classes.section
          : cn(
              "md:flex md:min-h-0 md:min-w-0 md:flex-1 md:flex-col md:overflow-hidden",
              PageSurface.raisedFromTablet,
            ),
      )}
    >
      <div
        ref={attachToolbar}
        data-shape="folder-toolbar"
        className={cn(
          // The selection bar covers this row and takes its colour (`bg-inherit`), so it is solid.
          "z-10 items-center gap-1 border-b",
          look
            ? look.classes.header
            : "surface-grain sticky top-16 -mx-4 -mt-6 mb-6 grid grid-cols-[minmax(0,1fr)_auto] border-border/70 bg-background px-4 py-3 md:relative md:top-auto md:m-0 md:flex md:h-14 md:shrink-0 md:border-border/60 md:bg-card md:bg-none md:px-2 md:pl-4 md:py-0 lg:pl-2",
        )}
      >
        {/* Alone, a folder shows Back and Up where its content area holds two panes side by side
            (see `SplitRoom`), so its path lines up with a split's left pane; narrower, the path
            needs the room, and the row's wider padding keeps the root crumb's 44 px touch area
            inside the card. */}
        <div
          className={cn(
            "flex shrink-0 items-center",
            look ? look.classes.moves : SplitRoom.roomOnly,
          )}
        >
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label="Back"
            data-shape="back"
            title="Back"
            disabled={!moves.back}
            onClick={() => moves.back?.()}
            className="touch-hit shrink-0"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label="Up one level"
            data-shape="up"
            title="Up one level"
            disabled={!moves.up}
            onClick={() => moves.up?.()}
            className="touch-hit mr-1 shrink-0"
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
        <div
          data-shape="crumbs"
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
          look
            ? look.classes.body
            : "md:min-h-0 md:flex-1 md:overflow-y-auto md:p-4 md:[scrollbar-gutter:stable]",
        )}
      >
        {body}
      </div>
      {pane?.hint}
    </section>
  );
}
