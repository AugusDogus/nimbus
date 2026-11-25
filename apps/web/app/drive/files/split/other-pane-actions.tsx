import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, CopyPlus, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropTarget } from "../drop-target";
import {
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { trpc } from "@/lib/trpc";
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
  const top = useQuery(trpc.access.me.queryOptions()).data?.top ?? "";
  const target = { path: other.path, writable: other.writable };
  const refusal = (operation: "move" | "copy") => {
    const verdict = DropTarget.forItems(operation, targets, target);
    return verdict.kind === "refused"
      ? DropTarget.hint(verdict, target, top)
      : undefined;
  };
  const items = [
    ...(canMove
      ? [
          {
            operation: "move" as const,
            label: `Move to ${other.label}`,
            // Points at the other pane.
            icon: other.side === "right" ? ArrowRight : ArrowLeft,
            run: () => void actions.moveEntries(targets, other.path),
          },
        ]
      : []),
    {
      operation: "copy" as const,
      label: `Copy to ${other.label}`,
      icon: CopyPlus,
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
        aria-label={item.label}
        title={reason ?? item.label}
        onClick={item.run}
        leadingIcon={item.icon}
        // The label truncates inside the button's own spans when the bar is short of room.
        className="touch-hit min-w-0 gap-2 pointer-coarse:min-w-11 @max-md:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:max-w-full [&>span:last-child>span]:min-w-0 [&>span:last-child>span]:overflow-hidden"
      >
        {/* In a pane's bar the folder's name shows where the pane has room for it; narrower,
            as on a phone, Move still says what it does, and the panes' switcher names where. */}
        <span
          aria-hidden
          className={
            labelled ? "hidden @md:block @md:max-w-40 @md:truncate" : "hidden"
          }
        >
          {item.label}
        </span>
        {labelled && item.operation === "move" && (
          <span aria-hidden className="@md:hidden">
            Move
          </span>
        )}
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
