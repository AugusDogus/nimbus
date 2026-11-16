import * as React from "react";

const MOBILE_BREAKPOINT = 768;

// React compares snapshots, so only a resize across the breakpoint re-renders.
const subscribe = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};

/** Whether the viewport is narrower than the `md` breakpoint, right from the first render. */
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < MOBILE_BREAKPOINT,
  );
}
