import type { UseNavigateResult } from "@tanstack/react-router";
import { Columns2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { CodeLoad } from "@/lib/code-load";
import { cn } from "@/lib/utils";
import { SplitCode } from "./split-frame";
import { SplitRoom } from "./split-room";
import { FiltersRow, type FiltersRowProps } from "./filters-row";

/** Opens a split view beside `left`, with `right` in the other pane or the remembered folder. */
export function openSplit(
  navigate: UseNavigateResult<string>,
  left: string,
  right: string | null,
) {
  void SplitCode.load().then(
    ({ openSplit }) => openSplit({ navigate, left, right }),
    (error: unknown) => CodeLoad.failed(error),
  );
}

/**
 * Opens a split view beside the folder shown, or closes the one open, keeping the active pane's
 * folder. In the header beside the account menu (see `HeaderTools`), in windows with room for
 * two panes side by side; narrower, a folder card's own Split opens one (`SplitButton`), and
 * each pane's Close ends it (see `SplitRoom`).
 */
export function SplitToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip content={open ? "Close split view" : "Open split view"}>
      <Button
        variant="ghost"
        size="icon-compact"
        aria-label="Split view"
        data-shape="split-toggle"
        aria-pressed={open}
        className={cn(
          "touch-hit text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground",
          // reach: narrower windows open a split from the folder card's Split, close it per pane.
          SplitRoom.sideBySideOnly,
        )}
        onClick={onToggle}
        // Pointed at or focused, it starts loading the split view's code.
        onPointerEnter={SplitCode.preload}
        onFocus={SplitCode.preload}
      >
        <Columns2 className="size-4" />
      </Button>
    </Tooltip>
  );
}

/**
 * Opens a split view beside the folder, from the folder card's own header, where a thumb reaches
 * it: in windows that show one pane at a time. Wider, the header's toggle does (`SplitToggle`).
 */
export function SplitButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button
      variant="tertiary"
      size="compact"
      leadingIcon={Columns2}
      data-shape="split-button"
      // reach: wider windows open a split from the header's Split view toggle.
      className={cn("touch-hit shrink-0", SplitRoom.swipeOnly)}
      onClick={onOpen}
      onPointerEnter={SplitCode.preload}
      onFocus={SplitCode.preload}
    >
      Split
    </Button>
  );
}

/**
 * A folder's own tools when alone: its sort and view, and on a phone, Split, which takes the view
 * toggle's place there; the sort and filter drawer offers the view.
 */
export function AloneFolderTools({
  filters,
  onSplit,
}: {
  filters: FiltersRowProps;
  onSplit: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <FiltersRow {...filters} inlineView="wide" />
      <SplitButton onOpen={onSplit} />
    </div>
  );
}
