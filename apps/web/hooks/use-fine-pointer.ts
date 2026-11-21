import * as React from "react";

const query = "(any-pointer: fine)";

const subscribe = (onChange: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};

/**
 * Whether a mouse, trackpad or pen is available, whatever the window's width: what dragging
 * items needs. Touch alone moves items through the Move action instead. Matches the CSS
 * `any-pointer-fine` variant the layout uses for the same question.
 */
export function useFinePointer() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
