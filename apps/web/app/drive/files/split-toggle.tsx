import type { UseNavigateResult } from "@tanstack/react-router";
import { Columns2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CodeLoad } from "@/lib/code-load";
import { SplitCode } from "./split-frame";

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
 * folder. In the header beside the account menu (see `HeaderTools`), from 1024 px; narrower
 * screens show one folder at a time.
 */
export function SplitToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label="Split view"
            data-shape="split-toggle"
            aria-pressed={open}
            className="touch-hit text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground max-lg:hidden"
            onClick={onToggle}
            // Pointed at or focused, it starts loading the split view's code.
            onPointerEnter={SplitCode.preload}
            onFocus={SplitCode.preload}
          />
        }
      >
        <Columns2 className="size-4" />
      </TooltipTrigger>
      <TooltipContent>
        <p>{open ? "Close split view" : "Open split view"}</p>
      </TooltipContent>
    </Tooltip>
  );
}
