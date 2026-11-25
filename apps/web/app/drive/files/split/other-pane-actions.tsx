import { ArrowLeft, ArrowRight, CopyPlus, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropTarget } from "../drop-target";
import {
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import type { MenuAction, OtherPaneActionsProps } from "../selection-bar";

/** The renderer the split view puts in `OtherPaneActionsSlot`. */
export const renderOtherPaneActions = (props: OtherPaneActionsProps) => (
  <OtherPaneActions {...props} />
);

/**
 * Move or copy the selection straight into the other pane's folder, without the picker: offered
 * with a split view, and disabled with the reason where that folder cannot take it. In a pane,
 * also the menu of the selection's less frequent actions.
 */
/** In a pane's narrower bar, the selection's less frequent actions. Last in the bar. */
function MoreActions({ items }: { items: readonly MenuAction[] }) {
  return (
    <DropdownMenu>
      <DropdownTrigger
        render={
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label="More actions"
            title="More actions"
            className="touch-hit order-last"
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </DropdownTrigger>
      <DropdownContent align="end" className="w-48">
        {items.map((item, index) => (
          <MenuItem
            key={item.label}
            index={index}
            label={item.label}
            onSelect={item.run}
          />
        ))}
      </DropdownContent>
    </DropdownMenu>
  );
}

export function OtherPaneActions({
  targets,
  other,
  canMove,
  more,
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
            // Points at the other pane.
            icon:
              other.side === "right" ? (
                <ArrowRight className="size-4" />
              ) : (
                <ArrowLeft className="size-4" />
              ),
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
  const labelled = more !== null;
  const buttons = items.map((item) => {
    const reason = refusal(item.operation);
    return (
      <Button
        key={item.operation}
        variant="ghost"
        size="compact"
        disabled={reason !== undefined}
        title={reason ?? item.label}
        onClick={item.run}
        className="touch-hit min-w-0 gap-2 pointer-coarse:min-w-11"
      >
        {item.icon}
        <span
          className={
            labelled
              ? "sr-only @md:not-sr-only @md:max-w-40 @md:truncate"
              : "sr-only"
          }
        >
          {item.label}
        </span>
      </Button>
    );
  });
  return (
    <>
      {buttons}
      {more && <MoreActions items={more} />}
    </>
  );
}
