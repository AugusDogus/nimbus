import { useSyncExternalStore } from "react";
import { CodeLoad } from "@/lib/code-load";

export type EntryIconProps = {
  type: string;
  name: string;
  /** Size and placement; theme images and Nimbus's own icons share it. */
  className: string;
  /**
   * The icon set to draw from: a manifest URL, or null for Nimbus's own icons, as settings
   * previews show them. Entries leave it out to use the account's set.
   */
  manifest?: string | null;
};

type IconRuntime = typeof import("./file-icon-theme");

/**
 * File pages carry only this slot. The code that resolves names against an icon theme and draws
 * Nimbus's own icons (file-icon-theme.tsx) loads beside the page: the server hints it with the
 * page's chunks, and loading starts as soon as this module runs. Listings wait for
 * `prepareEntryIcons` before they show, so rows never paint an empty slot or swap icons.
 */
let runtime: IconRuntime | null = null;
const listeners = new Set<() => void>();
const loading = CodeLoad.load(() => import("./file-icon-theme")).then(
  (module) => {
    runtime = module;
    for (const listener of listeners) listener();
    return module;
  },
);
loading.catch(() => {
  // The code load notice offers a reload; entries draw an empty slot until then.
});

/**
 * Resolves once `entries` can draw their final icons at first paint: the icon code, the account's
 * set and every icon the first screen of them uses are loaded and decoded. `folder` is the folder
 * they list, whose icons then come in one response. It never fails, and a listing waits for it
 * only so long (see `prepareEntries`).
 */
export const prepareEntryIcons = (
  entries: readonly { type: string; name: string }[],
  folder?: string,
) =>
  loading
    .then((module) => module.prepareEntries(entries, folder))
    .catch(() => {
      // Without the icon code or set, entries draw Nimbus's own icons or an empty slot.
    });

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** An entry's icon, in the box its row or card gives it; empty only while the code loads. */
export function EntryIcon(props: EntryIconProps) {
  const loaded = useSyncExternalStore(
    subscribe,
    () => runtime,
    () => null,
  );
  return loaded ? (
    <loaded.EntryIcon {...props} />
  ) : (
    <span aria-hidden className={props.className} />
  );
}
