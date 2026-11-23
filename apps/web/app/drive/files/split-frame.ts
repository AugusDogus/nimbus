import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { CodeLoad } from "@/lib/code-load";
import type { PaneFrame } from "./files-page-client";
import type { PaneLinks } from "./pane-links";
import type { OtherPaneActionsProps } from "./selection-bar";
import type { OtherPane, SplitControl } from "./split-layout";

/**
 * What a split view gives the page's folder frame (see `FilesPageClient`). The frame's first
 * place always holds the same folder element, so opening or closing the split never remounts the
 * first folder: it only gains or loses its pane's parts.
 */
export type SplitFrame = {
  /** Two panes side by side in `style`'s columns, or one where they do not fit. */
  sideBySide: boolean;
  style: CSSProperties | undefined;
  /** The first place: a folder, as a pane or alone, or the left pane folded away. */
  first:
    | {
        kind: "folder";
        path: string;
        pane: PaneFrame | null;
        other: OtherPane;
        control: SplitControl;
        links: PaneLinks;
      }
    | { kind: "collapsed"; element: ReactNode };
  /** After the first place: the divider and the right pane. */
  rest: ReactNode;
  /** Outside the frame: the split's own dialog and announcements. */
  extras: ReactNode;
  otherPaneActions: (props: OtherPaneActionsProps) => ReactNode;
};

/**
 * The split view's current frame, which its controller publishes after each of its renders. A
 * store rather than state, so the controller can sit beside the frame instead of around it.
 */
let current: SplitFrame | null = null;
const listeners = new Set<() => void>();

export const SplitFrameStore = {
  get: () => current,
  set(frame: SplitFrame | null) {
    current = frame;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
} as const;

export function useSplitFrame() {
  return useSyncExternalStore(
    SplitFrameStore.subscribe,
    SplitFrameStore.get,
    () => null,
  );
}

type SplitModule = typeof import("./split/split-view");

let loaded: SplitModule | null = null;
let loading: Promise<SplitModule> | null = null;

/**
 * The split view's code: the opener, the controller and the panes' parts, in one load. It
 * starts before anyone asks for a split, when the toggle is pointed at or focused, when a listing
 * takes focus, and once a folder page has settled, so opening one waits for nothing.
 */
function load() {
  loading ??= CodeLoad.load(() => import("./split/split-view")).then(
    (module) => (loaded = module),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

export const SplitCode = {
  load,
  /** The code, if it has arrived. */
  current: () => loaded,
  /**
   * Starts loading in the background. A failure here says nothing yet: opening a split loads
   * again, and reports a failure then.
   */
  preload() {
    if (!loaded) load().catch(() => undefined);
  },
} as const;

/** The split view's code once it is here, loading it when `wanted`. */
export function useSplitCode(wanted: boolean) {
  const [code, setCode] = useState(SplitCode.current);
  useEffect(() => {
    if (!wanted || code) return;
    let current = true;
    SplitCode.load().then(
      (module) => {
        if (current) setCode(module);
      },
      (error: unknown) => CodeLoad.failed(error),
    );
    return () => {
      current = false;
    };
  }, [wanted, code]);
  return code ?? SplitCode.current();
}
