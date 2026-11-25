import { useEffect, useRef, type ComponentProps } from "react";

import {
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { useColorScheme } from "@/lib/color-scheme";
import { ThemeToggleButton } from "./theme-toggle";

export type ThemeMenuProps = {
  side: ComponentProps<typeof DropdownContent>["side"];
  /** Opens as it mounts: the button was pressed while the menu loaded. */
  defaultOpen: boolean;
  /** Takes focus as it mounts: the button it replaces had it. */
  focusTrigger: boolean;
};

/** The theme toggle's menu, loaded by `ThemeToggle` when it is first needed. */
export function ThemeMenu({ side, defaultOpen, focusTrigger }: ThemeMenuProps) {
  const { setScheme } = useColorScheme();
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusTrigger && !defaultOpen) trigger.current?.focus();
  }, [focusTrigger, defaultOpen]);
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownTrigger render={<ThemeToggleButton ref={trigger} />} />
      <DropdownContent align="end" side={side} sideOffset={8} className="w-40">
        <MenuItem index={0} label="Light" onSelect={() => setScheme("light")} />
        <MenuItem index={1} label="Dark" onSelect={() => setScheme("dark")} />
        <MenuItem
          index={2}
          label="System"
          onSelect={() => setScheme("system")}
        />
      </DropdownContent>
    </DropdownMenu>
  );
}
