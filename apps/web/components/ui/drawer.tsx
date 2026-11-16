"use client";

import * as React from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";

import { cn } from "@/lib/utils";

/** A bottom sheet. Swiping it down dismisses it. */
function Drawer({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerClose({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

// Slides on the compositor: transform and opacity only, following the finger while swiped.
const easing = "ease-[cubic-bezier(0.32,0.72,0,1)]";

function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Popup>) {
  return (
    <DrawerPrimitive.Portal>
      <DrawerPrimitive.Backdrop
        data-slot="drawer-overlay"
        className={cn(
          "fixed inset-0 z-50 bg-black/50 opacity-[calc(1-var(--drawer-swipe-progress))] transition-opacity duration-500 data-swiping:duration-0 data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] motion-reduce:transition-none",
          easing,
        )}
      />
      <DrawerPrimitive.Viewport className="fixed inset-0 z-50 flex items-end">
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          className={cn(
            "bg-background relative flex h-auto max-h-[80vh] w-full flex-col rounded-t-lg border-t outline-none [transform:translateY(var(--drawer-swipe-movement-y))] transition-transform duration-500 data-swiping:duration-0 data-swiping:select-none data-starting-style:[transform:translateY(100%)] data-ending-style:[transform:translateY(100%)] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] motion-reduce:transition-none",
            // The background continues below the sheet, so pulling it up never shows a gap.
            "after:bg-inherit after:absolute after:inset-x-0 after:top-full after:h-[200%]",
            easing,
            className,
          )}
          {...props}
        >
          <div
            aria-hidden="true"
            className="bg-muted mx-auto mt-4 h-2 w-[100px] shrink-0 rounded-full"
          />
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        "flex flex-col gap-0.5 p-4 text-center md:gap-1.5 md:text-left",
        className,
      )}
      {...props}
    />
  );
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-foreground font-semibold", className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
};
