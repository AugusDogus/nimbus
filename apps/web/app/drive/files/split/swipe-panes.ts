import { useEffect, useLayoutEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import type { PaneSide } from "../split-layout";

/** How long the frame must hold still before a swipe counts as having landed, in ms. */
const settleMs = 120;

const sideAt = (frame: HTMLElement): PaneSide =>
  frame.scrollLeft > (frame.scrollWidth - frame.clientWidth) / 2
    ? "right"
    : "left";

const offsetOf = (frame: HTMLElement, side: PaneSide) =>
  side === "left" ? 0 : frame.scrollWidth - frame.clientWidth;

/**
 * Keeps a swiping split view's frame (`frame`, or null where the panes sit side by side) on the
 * active pane, and the active pane on the one a swipe lands on. The frame scrolls sideways and
 * snaps a pane at a time by itself, in CSS: this only listens, passively, to where it settles.
 * The active pane shows at once when the panes arrive or the frame is resized, as when a phone
 * turns; when it changes, the frame glides there, unless the person prefers less motion.
 */
export function useSwipePanes(
  frame: HTMLElement | null,
  active: PaneSide,
  activate: (side: PaneSide) => void,
) {
  const reduce = useReducedMotion();
  const wanted = useRef(active);
  const swiping = useRef(false);
  useLayoutEffect(() => {
    const changed = wanted.current !== active;
    wanted.current = active;
    if (!frame || sideAt(frame) === active) return;
    frame.scrollTo({
      left: offsetOf(frame, active),
      behavior: changed && !reduce ? "smooth" : "instant",
    });
  }, [frame, active, reduce]);

  const latest = useRef(activate);
  useLayoutEffect(() => {
    latest.current = activate;
  });
  useEffect(() => {
    if (!frame) return;
    // The panes arrive after the frame, and a phone turning resizes it: each time, the active
    // pane shows, unless a swipe is under way.
    const align = () => {
      if (swiping.current) return;
      const left = offsetOf(frame, wanted.current);
      if (Math.abs(frame.scrollLeft - left) > 1)
        frame.scrollTo({ left, behavior: "instant" });
    };
    const resized = new ResizeObserver(align);
    resized.observe(frame);
    const added = new MutationObserver(align);
    added.observe(frame, { childList: true });
    align();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      swiping.current = false;
      const side = sideAt(frame);
      wanted.current = side;
      latest.current(side);
    };
    // `scrollend` where the browser has it; elsewhere, once scrolling has paused.
    const onScroll = () => {
      swiping.current = true;
      clearTimeout(timer);
      timer = setTimeout(settle, settleMs);
    };
    frame.addEventListener("scroll", onScroll, { passive: true });
    frame.addEventListener("scrollend", settle);
    return () => {
      clearTimeout(timer);
      resized.disconnect();
      added.disconnect();
      frame.removeEventListener("scroll", onScroll);
      frame.removeEventListener("scrollend", settle);
    };
  }, [frame]);
}
