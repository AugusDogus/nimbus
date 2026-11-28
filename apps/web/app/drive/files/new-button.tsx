import { Plus } from "lucide-react";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NewTarget } from "./new-target";

/**
 * New's looks, in the create colour, as the page and its skeleton draw it: in the sidebar from
 * 768 px, and floating at the bottom right below that.
 */
const looks = {
  sidebar: cn("h-12 w-full rounded-full", PageLayout.createButton),
  floating: cn(
    // reach: from 768 px the sidebar's New button
    "fixed bottom-[calc(max(1.5rem,env(safe-area-inset-bottom))+var(--impersonation-offset,0px))] right-4 z-20 h-14 rounded-full px-6 shadow-lg md:hidden",
    PageLayout.createButton,
  ),
} as const;

/**
 * How New behaves for where it creates. While the page's answer is on its way it does nothing,
 * at full strength as its skeleton drew it. Where there is nowhere to create, it stays, dimmed
 * but still pressable, so a press, a hover or focus can say why (see `NewTarget`).
 */
function state(target: NewTarget) {
  switch (target.kind) {
    case "pending":
      return {
        disabled: true,
        className: "disabled:not-aria-busy:opacity-100",
      } as const;
    case "none":
      return { "aria-disabled": true, className: "opacity-50" } as const;
    case "folder":
    case "home":
      return { className: "" } as const;
  }
}

/** The floating New as a skeleton draws it, before the app runs. */
function FloatingPlaceholder() {
  return (
    <Button
      leadingIcon={Plus}
      tabIndex={-1}
      data-shape="new-floating"
      className={looks.floating}
    >
      New
    </Button>
  );
}

export const NewButton = { looks, state, FloatingPlaceholder } as const;
