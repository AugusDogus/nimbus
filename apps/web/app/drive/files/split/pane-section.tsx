import {
  ArrowLeft,
  ArrowUp,
  PanelLeftOpen,
  PanelRightOpen,
  X,
} from "lucide-react";
import { createContext, useContext } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DriveRoot } from "@nimbus/api/drive-root";
import type { PaneFailure, PaneParts } from "../files-page-client";
import type { PaneSide } from "../split-layout";
import type { FileDrag } from "../use-file-drag";

const sideName = { left: "Left", right: "Right" } as const;

/** Where a pane can go: back to the folder it showed before, up a level, or its top folder. */
export type PaneMoves = {
  back: (() => void) | null;
  up: (() => void) | null;
  top: () => void;
};

/** Why a pane's folder cannot be shown, with ways on that keep the pane open. */
function PaneFailureView({
  failure,
  moves,
}: {
  failure: PaneFailure;
  moves: PaneMoves;
}) {
  const text =
    failure.code === "NOT_FOUND"
      ? {
          title: "Folder not found",
          body: "It may have moved or been deleted. The other pane is unchanged.",
        }
      : failure.code === "FORBIDDEN"
        ? {
            title: "You do not have access to this folder",
            body: "Ask a server administrator, or the person who shared it with you, for access.",
          }
        : {
            title: "Could not open this folder",
            body: "The server may be unavailable. Your files have not been changed.",
          };
  return (
    <div role="alert" className="space-y-4 rounded-lg border p-6">
      <h2 className="text-balance text-lg font-semibold">{text.title}</h2>
      <p className="text-pretty text-sm text-muted-foreground">{text.body}</p>
      <div className="flex flex-wrap gap-3">
        {failure.code === null && (
          <Button onClick={failure.retry}>Try again</Button>
        )}
        {moves.up && (
          <Button
            variant={failure.code === null ? "outline" : "default"}
            onClick={moves.up}
          >
            Open parent
          </Button>
        )}
        <Button variant="outline" onClick={moves.top}>
          Open {DriveRoot.label}
        </Button>
      </div>
    </div>
  );
}

/** What the split view tells a pane's frame about the pane around it. */
export type PaneChrome = {
  id: string;
  side: PaneSide;
  active: boolean;
  drag: FileDrag;
  moves: PaneMoves;
  /** Closes the split, keeping this pane's folder. */
  onOnly: () => void;
  onActivate: () => void;
};

export const PaneChrome = createContext<PaneChrome | null>(null);

/**
 * One pane of a split view: its toolbar, with Back and Up for the pane alone, then its listing
 * in a scroll area of its own. The pane's folder takes drops on its empty space and toolbar.
 * The active pane, which New, Upload and the page's commands act on, has a marked top edge.
 */
export function PaneSection({ parts }: { parts: PaneParts }) {
  const chrome = useContext(PaneChrome);
  if (!chrome)
    throw new Error(
      "A split view pane rendered outside its split view. Render FolderPane panes inside SplitView.",
    );
  const { id, side, active, drag, moves, onOnly, onActivate } = chrome;
  const { attachToolbar, breadcrumbs, filters, content, target } = parts;
  const highlighted = drag.dropState(target.path) === "allowed";
  return (
    <section
      id={id}
      data-pane={side}
      data-active={active ? true : undefined}
      aria-label={`${sideName[side]} pane${active ? " (active)" : ""}`}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col",
        highlighted &&
          "after:pointer-events-none after:absolute after:inset-0 after:z-20 after:outline-2 after:-outline-offset-2 after:outline-primary",
      )}
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
      {...drag.targetProps(target)}
    >
      <div
        ref={attachToolbar}
        className={cn(
          "surface-grain @container relative z-10 flex shrink-0 items-center gap-1 border-b border-t-2 border-b-border/70 bg-background py-2.5 pl-2 pr-3",
          active ? "border-t-primary" : "border-t-transparent",
        )}
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
        <div className="min-w-0 flex-1 overflow-hidden">{breadcrumbs}</div>
        {filters}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Show only this pane"
          title="Show only this pane"
          onClick={onOnly}
          className="touch-hit shrink-0"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-clip p-4 [scrollbar-gutter:stable]">
        {content.kind === "listing" ? (
          content.body
        ) : (
          <PaneFailureView failure={content.failure} moves={moves} />
        )}
      </div>
    </section>
  );
}

/** A pane folded away: a strip that names its folder and opens it again. */
export function CollapsedPane({
  side,
  label,
  onReopen,
}: {
  side: PaneSide;
  label: string;
  onReopen: () => void;
}) {
  const Icon = side === "left" ? PanelLeftOpen : PanelRightOpen;
  return (
    <section
      data-pane={side}
      data-collapsed
      aria-label={`${sideName[side]} pane (collapsed)`}
      className={cn(
        "flex min-h-0 flex-col items-center gap-3 bg-muted/40 py-3",
        side === "left" ? "border-r" : "border-l",
      )}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Reopen ${side} pane: ${label}`}
        title={`Reopen ${label}`}
        onClick={onReopen}
        className="touch-hit"
      >
        <Icon className="size-4" />
      </Button>
      <span
        aria-hidden
        className="min-h-0 truncate text-xs font-medium text-muted-foreground [writing-mode:vertical-rl]"
      >
        {label}
      </span>
    </section>
  );
}
