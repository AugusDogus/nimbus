import * as React from "react";
import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** Buttons a toast offers besides closing, such as Undo. */
type ToastData = {
  actions?: readonly (
    | { label: string; run: () => void; keepsToast?: never }
    | { label: string; run: () => Promise<unknown>; keepsToast: true }
  )[];
};

/** The app's toasts. Base UI drops toasts added before a `Toaster` mounts and subscribes. */
const toast = ToastPrimitive.createToastManager<ToastData>();

function ToastProvider({ ...props }: ToastPrimitive.Provider.Props) {
  return <ToastPrimitive.Provider {...props} />;
}

function ToastPortal({ ...props }: ToastPrimitive.Portal.Props) {
  return <ToastPrimitive.Portal data-slot="toast-portal" {...props} />;
}

// Placement, size, stacking and motion follow the toasts Nimbus has always shown: 356px wide at
// the bottom right, full width on narrow screens, 14px apart, and older toasts tucked behind the
// newest at 5% smaller per step until the stack is hovered or focused. The stack sits above the
// impersonation banner and, through --toast-clearance (see globals.css), above the floating New
// button and selection bar, so an error that stays until closed never covers them.
function ToastViewport({ className, ...props }: ToastPrimitive.Viewport.Props) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "pointer-events-none fixed right-6 bottom-[calc(max(1.5rem,env(safe-area-inset-bottom))+var(--impersonation-offset,0px)+var(--toast-clearance,0px))] z-[999999999] w-[356px] outline-none max-[600px]:right-4 max-[600px]:bottom-[calc(max(1rem,env(safe-area-inset-bottom))+var(--impersonation-offset,0px)+var(--toast-clearance,0px))] max-[600px]:left-4 max-[600px]:w-auto",
        className,
      )}
      {...props}
    />
  );
}

function Toast({ className, ...props }: ToastPrimitive.Root.Props) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(
        "group/toast bg-popover text-popover-foreground pointer-events-auto absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full touch-none rounded-(--radius) border shadow-[0_4px_12px_rgba(0,0,0,0.1)] outline-none select-none [overflow-wrap:anywhere] focus-visible:shadow-[0_4px_12px_rgba(0,0,0,0.1),0_0_0_2px_rgba(0,0,0,0.2)]",
        "[--expanded-y:calc(-1*var(--toast-offset-y)-var(--toast-index)*var(--gap)+var(--toast-swipe-movement-y))] [--gap:14px] [--scale:max(0,calc(1-var(--toast-index)*0.05))]",
        "h-[var(--toast-frontmost-height,auto)] [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-var(--toast-index)*var(--gap)))_scale(var(--scale))] [transition:transform_400ms,opacity_400ms,height_400ms,box-shadow_200ms] motion-reduce:transition-none",
        // Keeps the stack hovered while the pointer crosses the gap between expanded toasts.
        "after:absolute after:bottom-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
        "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--expanded-y))]",
        "data-limited:pointer-events-none data-limited:opacity-0 data-starting-style:opacity-0 data-starting-style:[transform:translateY(100%)] data-ending-style:opacity-0",
        "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(100%)]",
        "data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+100%+24px))] data-ending-style:data-[swipe-direction=down]:duration-200",
        "data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+100%+24px))_translateY(var(--expanded-y))] data-ending-style:data-[swipe-direction=right]:duration-200",
        "data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-100%-24px))_translateY(var(--expanded-y))] data-ending-style:data-[swipe-direction=left]:duration-200",
        "data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-100%-24px))] data-ending-style:data-[swipe-direction=up]:duration-200",
        className,
      )}
      {...props}
    />
  );
}

function ToastContent({ className, ...props }: ToastPrimitive.Content.Props) {
  return (
    <ToastPrimitive.Content
      data-slot="toast-content"
      className={cn(
        "flex h-full items-center gap-1.5 overflow-hidden p-4 text-[13px] transition-opacity duration-400 data-behind:not-data-expanded:pointer-events-none data-behind:not-data-expanded:opacity-0 motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn("leading-[1.5] font-medium", className)}
      {...props}
    />
  );
}

function ToastDescription({
  className,
  ...props
}: ToastPrimitive.Description.Props) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn(
        "text-muted-foreground leading-[1.4] font-normal",
        className,
      )}
      {...props}
    />
  );
}

function ToastAction({
  className,
  render = <Button variant="outline" size="sm" />,
  ...props
}: ToastPrimitive.Action.Props) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      render={render}
      className={cn("ml-auto shrink-0", className)}
      {...props}
    />
  );
}

function ToastClose({
  className,
  children,
  render = <Button variant="ghost" size="icon-sm" />,
  ...props
}: ToastPrimitive.Close.Props) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="Close toast"
      render={render}
      className={cn(
        "text-muted-foreground hover:text-foreground relative shrink-0 after:absolute after:-inset-2 after:content-['']",
        className,
      )}
      {...props}
    >
      {children ?? <XIcon aria-hidden="true" />}
    </ToastPrimitive.Close>
  );
}

function ToastIcon({ type }: { type: string | undefined }) {
  let icon: React.ReactNode = null;

  if (type === "success") {
    icon = <CircleCheckIcon aria-hidden="true" />;
  }

  if (type === "info") {
    icon = <InfoIcon aria-hidden="true" />;
  }

  if (type === "warning") {
    icon = <TriangleAlertIcon aria-hidden="true" />;
  }

  if (type === "error") {
    icon = <OctagonXIcon aria-hidden="true" />;
  }

  if (type === "loading") {
    icon = (
      <Loader2Icon
        className="animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }

  if (!icon) {
    return null;
  }

  return (
    <span
      data-slot="toast-icon"
      className="relative mr-1 -ml-[3px] flex size-4 shrink-0 items-center justify-start [&_svg]:pointer-events-none [&_svg]:-ml-px [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
    >
      {icon}
    </span>
  );
}

function ToastList() {
  const { toasts, close, update } = ToastPrimitive.useToastManager<ToastData>();

  // Toasts that time out need no close button: they also swipe away, or close with Escape after
  // F6 moves focus to them. One that stays until dismissed (timeout 0) has one.
  return toasts.map((toastItem) => (
    <Toast key={toastItem.id} toast={toastItem}>
      <ToastContent>
        <ToastIcon type={toastItem.type} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <ToastTitle />
          <ToastDescription />
          {toastItem.data?.actions && (
            <div className="mt-2 flex flex-wrap gap-2">
              {toastItem.data.actions.map((action) => (
                <Button
                  key={action.label}
                  variant="outline"
                  size="sm"
                  className="touch-hit"
                  onClick={() => {
                    if (!action.keepsToast) {
                      close(toastItem.id);
                      action.run();
                      return;
                    }
                    // Held while what the action opened is open, then given its full time again.
                    const { timeout } = toastItem;
                    update(toastItem.id, { timeout: 0 });
                    void action
                      .run()
                      .finally(() => update(toastItem.id, { timeout }));
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </div>
        <ToastAction />
        {toastItem.timeout === 0 && <ToastClose className="-my-1 -mr-2" />}
      </ToastContent>
    </Toast>
  ));
}

function Toaster({
  children,
  toastManager = toast,
  timeout = 4000,
  limit = 3,
  ...props
}: ToastPrimitive.Provider.Props) {
  return (
    <ToastProvider
      toastManager={toastManager}
      timeout={timeout}
      limit={limit}
      {...props}
    >
      {children}
      <ToastPortal>
        <ToastViewport>
          <ToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
}

const createToastManager = ToastPrimitive.createToastManager;
const useToastManager = ToastPrimitive.useToastManager;

export {
  Toaster,
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  createToastManager,
  toast,
  useToastManager,
};
