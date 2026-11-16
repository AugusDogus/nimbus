import * as React from "react"

const MOBILE_BREAKPOINT = 768

// React compares snapshots, so only a resize across the breakpoint re-renders.
const subscribe = (onChange: () => void) => {
  window.addEventListener("resize", onChange)
  return () => window.removeEventListener("resize", onChange)
}

/**
 * Whether the viewport is narrower than the `md` breakpoint. Components that mount on the client
 * read the right value on their first render. While hydrating, React uses the server's answer,
 * false, because the server cannot know the viewport, and re-renders once if it differs.
 */
export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, () => window.innerWidth < MOBILE_BREAKPOINT, () => false)
}
