import { useEffect, useRef } from "react";

/**
 * Runs `onClosed` once the dialog it sits in has closed and gone, for what Base UI's `finalFocus`
 * and `onOpenChangeComplete` did: Fluid Functionalism's dialog passes neither on. Place it inside
 * `DialogContent`, whose children unmount when its exit has played. `onClosed` runs a frame after
 * that, once the dialog has handed focus back, so it can move focus somewhere else.
 */
export function WhenDialogClosed({ onClosed }: { onClosed: () => void }) {
  const latest = useRef(onClosed);
  useEffect(() => {
    latest.current = onClosed;
  });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestAnimationFrame(() => {
        // Strict mode mounts it again at once in development: that is no close.
        if (!mounted.current) latest.current();
      });
    };
  }, []);
  return null;
}
