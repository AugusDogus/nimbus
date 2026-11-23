import { ArrowLeftRight, CopyPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropTarget } from "../drop-target";
import type { OtherPaneActionsProps } from "../selection-bar";

/** The renderer the split view puts in `OtherPaneActionsSlot`. */
export const renderOtherPaneActions = (props: OtherPaneActionsProps) => (
  <OtherPaneActions {...props} />
);

/**
 * Move or copy the selection straight into the other pane's folder, without the picker: offered
 * with a split view, and disabled with the reason where that folder cannot take it.
 */
export function OtherPaneActions({
  targets,
  other,
  canMove,
  labelled,
  actions,
}: OtherPaneActionsProps) {
  const target = { path: other.path, writable: other.writable };
  const refusal = (operation: "move" | "copy") => {
    const verdict = DropTarget.forItems(operation, targets, target);
    return verdict.kind === "refused"
      ? DropTarget.hint(verdict, target)
      : undefined;
  };
  const items = [
    ...(canMove
      ? [
          {
            operation: "move" as const,
            label: `Move to ${other.label}`,
            icon: <ArrowLeftRight className="size-4" />,
            run: () => void actions.moveEntries(targets, other.path),
          },
        ]
      : []),
    {
      operation: "copy" as const,
      label: `Copy to ${other.label}`,
      icon: <CopyPlus className="size-4" />,
      run: () => void actions.copyEntries(targets, other.path),
    },
  ];
  return items.map((item) => {
    const reason = refusal(item.operation);
    return (
      <Button
        key={item.operation}
        variant="ghost"
        size="sm"
        disabled={reason !== undefined}
        title={reason ?? item.label}
        onClick={item.run}
        className="touch-hit min-w-0 gap-2 pointer-coarse:min-w-11"
      >
        {item.icon}
        <span
          className={
            labelled
              ? "sr-only @2xl:not-sr-only @2xl:max-w-40 @2xl:truncate"
              : "sr-only"
          }
        >
          {item.label}
        </span>
      </Button>
    );
  });
}
