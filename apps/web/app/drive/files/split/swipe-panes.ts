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
const glideMs = 250;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

const sideAt = (frame: HTMLElement): PaneSide =>
  frame.scrollLeft > (frame.scrollWidth - frame.clientWidth) / 2
    ? "right"
    : "left";

const offsetOf = (frame: HTMLElement, side: PaneSide) =>
  side === "left" ? 0 : frame.scrollWidth - frame.clientWidth;

/**
 * Keeps a swiping split view's frame (`frame`, or null where the panes sit side by side) on the
 * active pane (`ActivePane`), and the active pane on the one a swipe lands on.
 *
 * A finger moves the frame by the browser's own scrolling, which snaps a pane at a time in CSS;
 * nothing here runs while it moves. Once it lands, the pane it shows becomes active, then
 * `activate` records it in the address. A pane chosen otherwise, by the switcher or the address,
 * glides into view with snapping held off, and is recorded once there; a finger on the frame
 * takes over from a glide at once. The active pane shows at once when the panes arrive or the
 * frame is resized, as when a phone turns, and without gliding where less motion is preferred.
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

    const record = (side: PaneSide) => latest.current.activate(side);
    // The panes arrive after the frame, and a phone turning resizes it: each time, the active
    // pane shows, unless a swipe or a glide is under way.
    const align = () => {
      const side = ActivePane.get();
      if (swiping || glide || !side) return;
      const left = offsetOf(frame, side);
      if (Math.abs(frame.scrollLeft - left) > 1)
        frame.scrollTo({ left, behavior: "instant" });
    };
    const resized = new ResizeObserver(align);
    resized.observe(frame);
    const added = new MutationObserver(align);
    added.observe(frame, { childList: true });
    align();

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
      if (glide) return;
      swiping = true;
      if (hasScrollEnd) return;
      clearTimeout(timer);
      timer = setTimeout(settle, settleMs);
    };

    // A pane chosen by the switcher or the address: glide to it, then record it.
    const show = () => {
      const side = ActivePane.get();
      if (!side || swiping) return;
      glide?.cancel();
      const from = frame.scrollLeft;
      const to = offsetOf(frame, side);
      if (Math.abs(from - to) <= 1) return record(side);
      if (latest.current.reduce) {
        frame.scrollTo({ left: to, behavior: "instant" });
        return record(side);
      }
      // Snapping would pull each step of the glide back to a pane.
      frame.style.scrollSnapType = "none";
      const start = performance.now();
      let step = 0;
      const end = (landed: boolean) => {
        cancelAnimationFrame(step);
        frame.style.scrollSnapType = "";
        glide = null;
        if (landed) record(side);
      };
      const move = (now: number) => {
        const progress = Math.min(1, (now - start) / glideMs);
        frame.scrollLeft = from + (to - from) * easeOut(progress);
        if (progress < 1) step = requestAnimationFrame(move);
        else end(true);
      };
      glide = { cancel: () => end(false) };
      step = requestAnimationFrame(move);
    };
    const unsubscribe = ActivePane.subscribe(show);
    // A finger on the frame takes the glide over: it lands wherever the swipe does.
    const takeOver = () => {
      if (!glide) return;
      glide.cancel();
      swiping = true;
    };

    frame.addEventListener("scroll", onScroll, { passive: true });
    frame.addEventListener("scrollend", settle);
    frame.addEventListener("touchstart", takeOver, { passive: true });
    frame.addEventListener("wheel", takeOver, { passive: true });
    return () => {
      clearTimeout(timer);
      glide?.cancel();
      unsubscribe();
      resized.disconnect();
      added.disconnect();
      frame.removeEventListener("scroll", onScroll);
      frame.removeEventListener("scrollend", settle);
      frame.removeEventListener("touchstart", takeOver);
      frame.removeEventListener("wheel", takeOver);
    };
  }, [frame]);
}
