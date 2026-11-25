import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Confirmations, drawn with Fluid Functionalism's dialog, which has no alert dialog of its own.
 * Base UI's alert dialog root keeps what makes one: it is announced as an alert dialog, and only
 * its buttons or Escape close it, never a press beside it. Their parts work under it unchanged.
 */
export const AlertDialog = AlertDialogPrimitive.Root;

/** The dialog's panel, without the close button: a confirmation is answered, not dismissed. */
export function AlertDialogContent(
  props: Omit<ComponentProps<typeof DialogContent>, "showCloseButton">,
) {
  return <DialogContent showCloseButton={false} {...props} />;
}

export const AlertDialogHeader = DialogHeader;
export const AlertDialogFooter = DialogFooter;
export const AlertDialogTitle = DialogTitle;
export const AlertDialogDescription = DialogDescription;

/** The answer that acts. It leaves closing to its caller, which may keep the dialog open while it works. */
export const AlertDialogAction = Button;

/** The answer that changes nothing, and closes the dialog. */
export function AlertDialogCancel({
  variant = "tertiary",
  size,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof DialogClose>, "render"> &
  Pick<ComponentProps<typeof Button>, "variant" | "size">) {
  // Their close renders the given element as it is: the label goes inside it.
  return (
    <DialogClose
      render={
        <Button variant={variant} size={size} className={className}>
          {children}
        </Button>
      }
      {...props}
    />
  );
}
