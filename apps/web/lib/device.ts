import { useLayoutEffect, useState, useSyncExternalStore } from "react";

/**
 * What the app may assume about the device it runs on. It asks two separate questions, and
 * nothing else in the app answers them:
 *
 * - Layout, `room`: is there room for the wide layout? By the window's width, `narrow` below
 *   48rem (768 px at the default font size), the same line as Tailwind's `md` breakpoint, so
 *   `md:` and `max-md:` in CSS are this question too. Where a component already knows its own
 *   width (a container query, or `Device.useWidth`), it asks its container instead of the window.
 * - Input, `pointer`: what is the primary pointer? By capability, never by width. `coarse` (a
 *   finger) opens item actions in a drawer and gets 44 px targets; `fine` (a mouse, trackpad or
 *   pen) can hover, so controls may wait for a hover to show; `none` has no pointer, as on a
 *   keyboard-only device. In CSS, `pointer-coarse:` and `pointer-fine:` are this question.
 *   `anyFine` says whether any pointer is fine, even when touch is primary: what dragging items
 *   needs (`any-pointer-fine:` in CSS).
 *
 * Two things are deliberately not device questions. A keyboard is never assumed absent: key
 * handlers work on every device. And a single gesture is judged by its own event: a press by a
 * finger (`event.pointerType === "touch"`) long-presses to select, on any device.
 */
export type Device = {
  room: "narrow" | "wide";
  pointer: "coarse" | "fine" | "none";
  anyFine: boolean;
};

/** Below this many pixels, at the default font size, the window is narrow (see `Device.query`). */
const narrowBelow = 768;

const query = {
  /** Tailwind's `max-md`, in rem as Tailwind writes it, so a larger default font moves both. */
  narrow: "(width < 48rem)",
  coarse: "(pointer: coarse)",
  fine: "(pointer: fine)",
  anyFine: "(any-pointer: fine)",
} as const;

// One subscription per query, kept stable so React does not resubscribe on every render.
const subscriptions = new Map<string, (onChange: () => void) => () => void>();
function subscribeTo(media: string) {
  let subscribe = subscriptions.get(media);
  if (!subscribe) {
    subscribe = (onChange) => {
      const list = window.matchMedia(media);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    };
    subscriptions.set(media, subscribe);
  }
  return subscribe;
}

/**
 * Whether `media` matches, from the first client render, updating when it changes. Markup
 * rendered on the server, such as a page's skeleton, takes `false`; CSS on the same question
 * corrects it before the first paint.
 */
function useMedia(media: string) {
  return useSyncExternalStore(
    subscribeTo(media),
    () => window.matchMedia(media).matches,
    () => false,
  );
}

export const Device = {
  narrowBelow,
  query,

  /** The device as `matches` answers the media queries in `Device.query`. */
  read(matches: (media: string) => boolean): Device {
    return {
      room: matches(query.narrow) ? "narrow" : "wide",
      pointer: matches(query.coarse)
        ? "coarse"
        : matches(query.fine)
          ? "fine"
          : "none",
      anyFine: matches(query.anyFine),
    };
  },

  /**
   * Whether shortcuts use Command rather than Ctrl, and Option rather than Ctrl to copy while
   * dragging: macOS, iPhone and iPad.
   */
  isMac(
    userAgent: string | undefined = typeof navigator === "undefined"
      ? undefined
      : navigator.userAgent,
  ): boolean {
    return userAgent !== undefined && /Mac|iPhone|iPad/.test(userAgent);
  },

  /** The layout question: the window is too narrow for the wide layout. */
  useNarrow(): boolean {
    return useMedia(query.narrow);
  },

  /** The input question: the primary pointer is a finger. */
  useCoarsePointer(): boolean {
    return useMedia(query.coarse);
  },

  /** Some pointer is a mouse, trackpad or pen, even beside a touch screen: items can be dragged. */
  useAnyFinePointer(): boolean {
    return useMedia(query.anyFine);
  },

  /**
   * The layout question for one component: its element's width in pixels, measured before the
   * first paint and whenever it changes; null until there is an element.
   */
  useWidth(element: HTMLElement | null): number | null {
    const [width, setWidth] = useState<number | null>(null);
    useLayoutEffect(() => {
      if (!element) return;
      const measure = () => setWidth(element.getBoundingClientRect().width);
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }, [element]);
    return element ? width : null;
  },
} as const;
