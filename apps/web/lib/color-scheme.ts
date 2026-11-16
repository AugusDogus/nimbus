import { useCallback, useSyncExternalStore } from "react";
import { colorSchemeStorageKey } from "./color-scheme-key";

/** The color scheme a person chose. `system` follows the operating system. */
export type ColorScheme = "system" | "light" | "dark";

const darkQuery = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

const parse = (value: string | null): ColorScheme =>
  value === "light" || value === "dark" ? value : "system";

function read(): ColorScheme {
  try {
    return parse(localStorage.getItem(colorSchemeStorageKey));
  } catch {
    return "system";
  }
}

const systemScheme = () =>
  window.matchMedia(darkQuery).matches ? "dark" : "light";

/**
 * Sets the `light` or `dark` class and `color-scheme` on the root element. Transitions are
 * suppressed for one frame so colors switch at once rather than animating.
 */
function apply(scheme: ColorScheme) {
  const resolved = scheme === "system" ? systemScheme() : scheme;
  const root = document.documentElement;
  if (root.classList.contains(resolved) && root.style.colorScheme === resolved)
    return;
  const pause = document.createElement("style");
  pause.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.append(pause);
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  // Reading a computed style flushes it before transitions return.
  window.getComputedStyle(document.body);
  setTimeout(() => pause.remove(), 1);
}

function notify() {
  apply(read());
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    window.matchMedia(darkQuery).addEventListener("change", notify);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      window.matchMedia(darkQuery).removeEventListener("change", notify);
    }
  };
}

function onStorage(event: StorageEvent) {
  if (event.key === colorSchemeStorageKey) notify();
}

export const ColorScheme = {
  parse,
  /** Saves `scheme` for this browser and applies it everywhere it is open. */
  set(scheme: ColorScheme) {
    try {
      localStorage.setItem(colorSchemeStorageKey, scheme);
    } catch {
      // Storage can be unavailable; the choice still applies to this page.
    }
    apply(scheme);
    for (const listener of listeners) listener();
  },
} as const;

/** The chosen color scheme, kept in step with other tabs and the operating system. */
export function useColorScheme() {
  // A page the server renders cannot know the choice; the browser corrects it after hydration.
  const scheme = useSyncExternalStore(subscribe, read, () => "system" as const);
  const set = useCallback((next: ColorScheme) => ColorScheme.set(next), []);
  return { scheme, setScheme: set };
}
