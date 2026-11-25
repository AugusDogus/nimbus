import { Moon, Sun } from "lucide-react";
import {
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
} from "react";

import { Button } from "@/components/ui/button";
import type { ThemeMenuProps } from "./theme-menu";

type ThemeToggleProps = { side?: ThemeMenuProps["side"] };

/** The toggle's button, the same before and after its menu has loaded. */
export function ThemeToggleButton(props: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      className="relative"
      {...props}
    >
      <Sun className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
      <Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}

const loadMenu = () => import("./theme-menu");

/**
 * The light, dark and system choice on the public share and upload pages. Its menu draws with
 * motion, which those pages otherwise never load, so the menu loads only once the button is
 * pointed at, focused or pressed; a press opens it as soon as it has loaded.
 */
export function ThemeToggle({ side = "bottom" }: ThemeToggleProps) {
  const [menu, setMenu] = useState<{
    Menu: ComponentType<ThemeMenuProps>;
    open: boolean;
    focused: boolean;
  } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wantsOpen = useRef(false);
  const load = (open: boolean) => {
    wantsOpen.current ||= open;
    void loadMenu().then(({ ThemeMenu }) =>
      setMenu(
        (shown) =>
          shown ?? {
            Menu: ThemeMenu,
            open: wantsOpen.current,
            focused: document.activeElement === button.current,
          },
      ),
    );
  };
  if (menu) {
    const { Menu } = menu;
    return (
      <Menu side={side} defaultOpen={menu.open} focusTrigger={menu.focused} />
    );
  }
  return (
    <ThemeToggleButton
      ref={button}
      onPointerEnter={() => load(false)}
      onFocus={() => load(false)}
      onClick={() => load(true)}
    />
  );
}
