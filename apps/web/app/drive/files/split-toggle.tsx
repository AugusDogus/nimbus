import type { UseNavigateResult } from "@tanstack/react-router";
import { Columns2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CodeLoad } from "@/lib/code-load";

/** Opens a split view beside `left`, with `right` in the other pane or the remembered folder. */
export function openSplit(
  navigate: UseNavigateResult<string>,
  left: string,
  right: string | null,
) {
  void CodeLoad.load(() => import("./split/open-split")).then(
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
            size="icon-sm"
            aria-label="Split view"
            aria-pressed={open}
            className="touch-hit text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground max-lg:hidden"
            onClick={onToggle}
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
