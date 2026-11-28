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
let loading: Promise<IconRuntime> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<IconRuntime> {
  loading ??= CodeLoad.load(() => import("./file-icon-theme")).then(
    (module) => {
      runtime = module;
      for (const listener of listeners) listener();
      return module;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}
load().catch(() => {
  // The code load notice offers a reload; entries draw an empty slot until then.
});

/** At most this long a listing waits for its icons; past it, rows show and icons follow. */
const maxWaitMs = 4000;

/**
 * Resolves once `entries` can draw their final icons at first paint: the icon code, the account's
 * set and every icon they use are loaded and decoded. `folder` is the folder they list, whose
 * icons can then come in one response. It never fails, and a listing never waits for it longer
 * than `maxWaitMs`.
 */
export async function prepareEntryIcons(
  entries: readonly { type: string; name: string }[],
  folder?: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    load()
      .then((module) => module.prepareEntries(entries, folder))
      .catch(() => {
        // Without the icon code or set, entries draw Nimbus's own icons or an empty slot.
      }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxWaitMs);
    }),
  ]);
  clearTimeout(timer);
}

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
