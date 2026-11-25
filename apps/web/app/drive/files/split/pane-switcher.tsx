import { PanelLeft, PanelRight } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { PaneSide } from "../split-layout";

const sides = [
  { side: "left", name: "Left", Icon: PanelLeft },
  { side: "right", name: "Right", Icon: PanelRight },
] as const;

/**
 * Where two panes do not fit side by side: which pane shows, named by its folder, and the other
 * one a tap away. A swipe across the panes does the same.
 */
export function PaneSwitcher({
  labels,
  active,
  onShow,
}: {
  labels: Record<PaneSide, string>;
  active: PaneSide;
  onShow: (side: PaneSide) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Panes"
      value={[active]}
      onValueChange={([value]) => {
        if (value === "left" || value === "right") onShow(value);
      }}
      data-shape="pane-switcher"
      variant="default"
      size="sm"
      spacing={1}
      className="mb-3 grid w-full shrink-0 grid-cols-2 rounded-lg bg-muted/70 p-1 md:mx-2 md:mt-2 md:mb-2 md:w-auto"
    >
      {sides.map(({ side, name, Icon }) => (
        <ToggleGroupItem
          key={side}
          value={side}
          aria-label={`${name} pane: ${labels[side]}`}
          className="h-9 min-w-0 justify-start gap-2 rounded-md px-3 text-muted-foreground pointer-coarse:h-11 data-pressed:bg-card data-pressed:text-foreground data-pressed:shadow-sm dark:data-pressed:bg-accent"
        >
          <Icon className="size-4 shrink-0" />
          <span className="truncate text-sm">{labels[side]}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
