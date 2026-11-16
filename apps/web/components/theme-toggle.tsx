import { Moon, Sun } from "lucide-react";
import { useColorScheme } from "@/lib/color-scheme";
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type ThemeToggleProps = {
  side?: ComponentProps<typeof DropdownMenuContent>["side"];
};

export function ThemeToggle({ side = "bottom" }: ThemeToggleProps) {
  const { setScheme } = useColorScheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            className="relative"
          />
        }
      >
        <Sun className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
        <Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
        <span className="sr-only">Toggle theme</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={side} sideOffset={8}>
        <DropdownMenuItem onClick={() => setScheme("light")}>
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setScheme("dark")}>
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setScheme("system")}>
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
