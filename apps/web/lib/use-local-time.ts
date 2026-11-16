import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/**
 * `time` in the visitor's locale, as a date or a date and time. A page the server renders cannot
 * know the locale, so it renders "" there and the browser fills it in after hydration.
 */
export function useLocalTime(time: number, kind: "date" | "datetime") {
  return useSyncExternalStore(
    noSubscription,
    () =>
      kind === "date"
        ? new Date(time).toLocaleDateString()
        : new Date(time).toLocaleString(),
    () => "",
  );
}
