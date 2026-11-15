import { useSyncExternalStore } from "react";

// Card columns by viewport width, matching Tailwind's sm, md, lg, and xl breakpoints.
const breakpoints = [
  { query: "(min-width: 80rem)", columns: 6 },
  { query: "(min-width: 64rem)", columns: 5 },
  { query: "(min-width: 48rem)", columns: 4 },
  { query: "(min-width: 40rem)", columns: 3 },
] as const;

function columns() {
  return breakpoints.find((breakpoint) => window.matchMedia(breakpoint.query).matches)?.columns ?? 2;
}

function subscribe(onChange: () => void) {
  const lists = breakpoints.map((breakpoint) => window.matchMedia(breakpoint.query));
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
}

/** Grid columns for the current viewport. The server renders the desktop layout. */
export function useGridColumns() {
  return useSyncExternalStore(subscribe, columns, () => 5);
}
