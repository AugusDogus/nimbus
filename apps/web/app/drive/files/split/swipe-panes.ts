import { useEffect, useLayoutEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import type { PaneSide } from "../split-layout";
import { ActivePane } from "./active-pane";

/**
 * Where a browser has no `scrollend`: how long the frame must hold still before a swipe counts as
 * having landed, in ms.
 */
const settleMs = 120;
/**
 * A glide to the pane chosen by a tap: short and decelerating, so it starts at once and lands
 * softly, well under the 300 ms past which a switch feels slow.
 */
const glideMs = 240;
/** UI motion's strong ease-out, which `easeOut` computes for a glide. */
const easing = "cubic-bezier(0.23, 1, 0.32, 1)";
const easeOut = (t: number) => 1 - (1 - t) ** 3;
/**
 * A split just opened: the new pane enters, then the frame leans toward it and back once, so the
 * person sees there is a second pane to swipe to.
 */
const enter = { ms: 260, from: 24 };
const nudge = { delayMs: 280, ms: 560, px: 36 };
/** How long after a split is asked for its opening still shows, in ms. */
const openingMs = 3000;

const sideAt = (frame: HTMLElement): PaneSide =>
  frame.scrollLeft > (frame.scrollWidth - frame.clientWidth) / 2
    ? "right"
    : "left";

const offsetOf = (frame: HTMLElement, side: PaneSide) =>
  side === "left" ? 0 : frame.scrollWidth - frame.clientWidth;

/** When a person last asked for a split, which opens with an entrance; null once shown. */
let openedAt: number | null = null;

/**
 * Keeps a swiping split view's frame (`frame`, or null where the panes sit side by side) on the
 * active pane (`ActivePane`), and the active pane on the one a swipe lands on.
 *
 * A finger moves the frame by the browser's own scrolling, which snaps a pane at a time in CSS.
 * While it moves, only the panes' edge labels change, at most once a frame: each shows as far as
 * its pane is out of view, and takes a press or focus only while mostly out (`EdgeLabel`). Once
 * the frame lands, the pane it shows becomes active, then `activate` records it in the address. A
 * pane chosen otherwise, by its edge label or the address, glides into view with snapping held
 * off, and is recorded once there; a finger on the frame takes over from a glide at once. The
 * active pane shows at once when the panes arrive or the frame is resized, as when a phone turns,
 * and without gliding where less motion is preferred.
 */
export function useSwipePanes(
  frame: HTMLElement | null,
  activate: (side: PaneSide) => void,
) {
  const reduce = useReducedMotion();
  const latest = useRef({ activate, reduce });
  useLayoutEffect(() => {
    latest.current = { activate, reduce };
  });
  useEffect(() => {
    if (!frame) return;
    const hasScrollEnd = "onscrollend" in frame;
    let swiping = false;
    let glide: { cancel: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let painting = 0;

    const record = (side: PaneSide) => latest.current.activate(side);

    // Each pane's edge label, shown as far as its pane is out of view.
    const label = () => {
      painting = 0;
      const range = frame.scrollWidth - frame.clientWidth;
      const progress =
        range > 0 ? Math.min(1, Math.max(0, frame.scrollLeft / range)) : 0;
      for (const element of frame.querySelectorAll<HTMLElement>(
        "[data-edge-label]",
      )) {
        const away =
          element.dataset.edgeLabel === "left" ? progress : 1 - progress;
        element.style.setProperty("opacity", String(Math.min(1, away * 1.6)));
        const out = away > 0.5;
        element.style.setProperty("pointer-events", out ? "auto" : "none");
        element.inert = !out;
      }
    };
    const labelSoon = () => {
      if (!painting) painting = requestAnimationFrame(label);
    };

    // The panes arrive after the frame, and a phone turning resizes it: each time, the active
    // pane shows, unless a swipe or a glide is under way.
    const align = () => {
      const side = ActivePane.get();
      if (!swiping && !glide && side) {
        const left = offsetOf(frame, side);
        if (Math.abs(frame.scrollLeft - left) > 1)
          frame.scrollTo({ left, behavior: "instant" });
      }
      label();
    };

    /** Moves the frame by `to(progress)` over `ms` with snapping held off; a finger stops it. */
    const run = (
      ms: number,
      to: (progress: number) => number,
      done: (landed: boolean) => void,
    ) => {
      glide?.cancel();
      frame.style.setProperty("scroll-snap-type", "none");
      const start = performance.now();
      let step = 0;
      const end = (landed: boolean) => {
        cancelAnimationFrame(step);
        frame.style.removeProperty("scroll-snap-type");
        glide = null;
        done(landed);
      };
      const move = (now: number) => {
        const progress = Math.min(1, (now - start) / ms);
        frame.scrollLeft = to(progress);
        if (progress < 1) step = requestAnimationFrame(move);
        else end(true);
      };
      glide = { cancel: () => end(false) };
      step = requestAnimationFrame(move);
    };

    // A split just opened: the new pane enters, and the frame leans toward it and back.
    let opening = openedAt !== null && performance.now() - openedAt < openingMs;
    const greet = () => {
      const incoming = frame.children[1];
      if (!opening || !(incoming instanceof HTMLElement)) return;
      opening = false;
      openedAt = null;
      if (latest.current.reduce) return;
      incoming.animate(
        [
          { opacity: 0, transform: `translateX(${enter.from}px)` },
          { opacity: 1, transform: "none" },
        ],
        { duration: enter.ms, easing },
      );
      if (ActivePane.get() !== "left") return;
      const wait = setTimeout(() => {
        if (swiping || glide) return;
        run(
          nudge.ms,
          (k) => nudge.px * Math.sin(Math.PI * k) * (1 - k * 0.25),
          () => {
            frame.scrollLeft = 0;
          },
        );
      }, nudge.delayMs);
      leave.push(() => clearTimeout(wait));
    };
    const leave: (() => void)[] = [];

    const resized = new ResizeObserver(align);
    resized.observe(frame);
    const added = new MutationObserver(() => {
      align();
      greet();
    });
    added.observe(frame, { childList: true });
    align();
    greet();

    const settle = () => {
      clearTimeout(timer);
      if (glide) return;
      swiping = false;
      const side = sideAt(frame);
      // A new pane is shown and recorded by `show`; one that stayed is recorded here.
      if (ActivePane.get() === side) record(side);
      else ActivePane.set(side);
    };
    const onScroll = () => {
      labelSoon();
      if (glide) return;
      swiping = true;
      if (hasScrollEnd) return;
      clearTimeout(timer);
      timer = setTimeout(settle, settleMs);
    };

    // A pane chosen by its edge label or the address: glide to it, then record it.
    const show = () => {
      const side = ActivePane.get();
      if (!side || swiping) return;
      const from = frame.scrollLeft;
      const to = offsetOf(frame, side);
      if (Math.abs(from - to) <= 1) return record(side);
      if (latest.current.reduce) {
        frame.scrollTo({ left: to, behavior: "instant" });
        return record(side);
      }
      run(
        glideMs,
        (k) => from + (to - from) * easeOut(k),
        (landed) => {
          if (landed) record(side);
        },
      );
    };
    const unsubscribe = ActivePane.subscribe(show);
    // A finger moving on the frame takes a glide over: it lands wherever the swipe does. A tap
    // does not, as one on an edge label starts the glide.
    const takeOver = () => glide?.cancel();

    frame.addEventListener("scroll", onScroll, { passive: true });
    frame.addEventListener("scrollend", settle);
    frame.addEventListener("touchmove", takeOver, { passive: true });
    frame.addEventListener("wheel", takeOver, { passive: true });
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(painting);
      for (const undo of leave) undo();
      glide?.cancel();
      unsubscribe();
      resized.disconnect();
      added.disconnect();
      frame.removeEventListener("scroll", onScroll);
      frame.removeEventListener("scrollend", settle);
      frame.removeEventListener("touchmove", takeOver);
      frame.removeEventListener("wheel", takeOver);
    };
  }, [frame]);
}

/** The split view's swiping frame, one pane at a time on a phone (see `useSwipePanes`). */
export const SwipePanes = {
  /** A person asked for a split: when it shows one pane at a time, it opens with an entrance. */
  opening: () => {
    openedAt = performance.now();
  },
} as const;
