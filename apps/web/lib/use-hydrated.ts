import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False in markup the server rendered, until the browser has hydrated it, then true. A button
 * there reaches no handler before then, so actions wait for it; fields work from the start.
 */
export const useHydrated = () =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
