import { useLayoutEffect, useRef } from "react";
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

/** `easing` itself, its progress at time `t` (0 to 1), for motions built from several steps. */
function curve(t: number): number {
  const [x1, y1, x2, y2] = [0.23, 1, 0.32, 1];
  const at = (a: number, b: number, u: number) =>
    3 * a * u * (1 - u) ** 2 + 3 * b * u ** 2 * (1 - u) + u ** 3;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (at(x1, x2, mid) < t) low = mid;
    else high = mid;
  }
  return at(y1, y2, (low + high) / 2);
}
/**
 * A split just opened, in one motion and nothing after it: the pane the person is in eases from
 * the frame's whole width to a pane's, while the new pane slides in from the window's edge to
 * where it waits. The person stays on their folder.
 */
const opening = { ms: 260 };
/** How long after a split is asked for its opening still shows, in ms. */
const openingMs = 3000;
/**
 * How far back the pane out of view sits: its scale lost, and its tint, when wholly out. Where the
 * browser has scroll timelines, the stylesheet moves them on the compositor (`pane-back` and its
 * kin, with these numbers); elsewhere they are set here frame by frame.
 */
const depth = { scale: 0.07, tint: 0.55 };
const scrollTimelines =
  typeof CSS !== "undefined" && CSS.supports("animation-timeline", "scroll()");

const sideAt = (frame: HTMLElement): PaneSide =>
  frame.scrollLeft > (frame.scrollWidth - frame.clientWidth) / 2
    ? "right"
    : "left";

const offsetOf = (frame: HTMLElement, side: PaneSide) =>
  side === "left" ? 0 : frame.scrollWidth - frame.clientWidth;

/** The frame's whole width inside its padding, at the height of `pane`'s box. */
function wholeWidth(frame: HTMLElement, pane: DOMRect): DOMRect {
  const style = getComputedStyle(frame);
  const box = frame.getBoundingClientRect();
  const left = box.left + parseFloat(style.paddingLeft);
  const right = box.right - parseFloat(style.paddingRight);
  return new DOMRect(left, pane.top, right - left, pane.height);
}

/** Sent on the frame once a split's entrance is over (see `SwipePanes.enteredEvent`). */
const enteredEvent = "split-entered";

/**
 * When a person last asked for a split, which opens with an entrance, and where their folder's
 * card was on screen then; null once the entrance has started. `held` while a press prepares the
 * split out of sight: its entrance waits for the press to end in a click (see `SplitPress`).
 */
let asked: { at: number; from: DOMRect | null; held: boolean } | null = null;
const isAsked = () =>
  asked !== null && performance.now() - asked.at < openingMs;
/** The entrance under way, on its frame, and how to end it at once; null between them. */
let running: { frame: HTMLElement; stop: () => void } | null = null;
/** Each swiping frame's way to start an entrance, with its motion preference. */
const greeters = new Map<HTMLElement, () => void>();

/**
 * A split's entrance on `frame`, once both panes are in it, when one was asked for: the person's
 * pane eases from where their folder's card was to a pane's place while the new pane slides in.
 * Without motion, the split simply shows.
 */
function enter(frame: HTMLElement, reduce: boolean) {
  const side = ActivePane.get() ?? "left";
  const kept = frame.querySelector<HTMLElement>(
    `:scope > [data-pane="${side}"]`,
  );
  const incoming = frame.querySelector<HTMLElement>(
    `:scope > [data-pane="${side === "left" ? "right" : "left"}"]`,
  );
  if (!isAsked() || asked?.held || !kept || !incoming) return;
  const before = asked?.from ?? null;
  asked = null;
  /** The entrance is over: the pane standing in for the new one may give way to it. */
  const entered = () => frame.dispatchEvent(new Event(enteredEvent));
  if (reduce) return entered();
  // The panes' depth is theirs to set until they land (see the stylesheet's `data-entering`).
  frame.dataset.entering = "";
  // Each holds its last frame until the stylesheet's depth has taken over from it.
  const timing = { duration: opening.ms, easing, fill: "forwards" } as const;
  const linear = { ...timing, easing: "linear" };
  const animations: Animation[] = [];
  // The kept pane is laid out as a pane from the first frame. It starts where the folder's card
  // was, as wide, and eases into place by transform alone, its header and listing scaled back the
  // other way so their text is never stretched. Only transforms move, which the compositor runs
  // on its own: the motion goes on while the page is busy.
  const to = kept.getBoundingClientRect();
  const start = before ?? wholeWidth(frame, to);
  const parts = [
    ...kept.querySelectorAll<HTMLElement>(
      ':scope > [data-shape="folder-toolbar"], :scope > [data-slot="folder-list"]',
    ),
  ];
  if (to.width > 0 && start.width > 0) {
    const at = (k: number) => {
      const e = curve(k);
      return {
        x: (start.left - to.left) * (1 - e),
        y: (start.top - to.top) * (1 - e),
        scale: start.width / to.width + (1 - start.width / to.width) * e,
      };
    };
    const steps = Array.from({ length: 13 }, (_, i) => at(i / 12));
    // Each from its left edge. Set on the elements for the motion, as an animated origin would
    // keep it off the compositor.
    for (const element of [kept, ...parts])
      element.style.setProperty("transform-origin", "0 0");
    animations.push(
      kept.animate(
        steps.map(({ x, y, scale }) => ({
          transform: `translate(${x}px, ${y}px) scaleX(${scale})`,
        })),
        linear,
      ),
      ...parts.map((part) =>
        part.animate(
          steps.map(({ scale }) => ({ transform: `scaleX(${1 / scale})` })),
          linear,
        ),
      ),
    );
  }
  const edge = frame.getBoundingClientRect();
  const box = incoming.getBoundingClientRect();
  const from = side === "left" ? edge.right - box.left : edge.left - box.right;
  // It arrives a step back, wholly out of view, and holds that depth all the way.
  const back = `scale(${1 - depth.scale})`;
  animations.push(
    incoming.animate(
      [{ transform: `translateX(${from}px) ${back}` }, { transform: back }],
      timing,
    ),
  );
  const stop = () => {
    delete frame.dataset.entering;
    for (const animation of animations) animation.cancel();
    for (const element of [kept, ...parts])
      element.style.removeProperty("transform-origin");
    if (running?.frame === frame) running = null;
  };
  running = { frame, stop };
  const landed = () => {
    if (running?.frame !== frame) return;
    // The stylesheet's depth comes back, the same as where the panes came to rest, and the panes
    // let go of their last frame once it shows.
    delete frame.dataset.entering;
    requestAnimationFrame(() => {
      stop();
      entered();
    });
  };
  Promise.all(animations.map((animation) => animation.finished)).then(
    landed,
    landed,
  );
}

/**
 * Keeps a swiping split view's frame (`frame`, or null where the panes sit side by side) on the
 * active pane (`ActivePane`), and the active pane on the one a swipe lands on.
 *
 * A finger moves the frame by the browser's own scrolling, which snaps a pane at a time in CSS.
 * While it moves, only the panes' depth changes, at most once a frame: each pane sits further back,
 * smaller and tinted, as far as it is out of view, and takes a press or focus only while mostly
 * out (`PaneDepth`). Once the frame lands, the pane it shows becomes active, then `activate`
 * records it in the address. A pane chosen otherwise, by a tap on it or the address, glides into
 * view with snapping held off, and is recorded once there; a finger moving on the frame takes over
 * from a glide at once. The
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
  // Set up in the commit that lays the panes out, before it is painted: a split's entrance starts
  // in the first frame that shows the split, never one after it.
  useLayoutEffect(() => {
    if (!frame) return;
    const hasScrollEnd = "onscrollend" in frame;
    let swiping = false;
    let glide: { cancel: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let painting = 0;

    const record = (side: PaneSide) => latest.current.activate(side);

    /** The panes in the frame, each with how far it is out of view (0 in view, 1 out). */
    const panes = () => {
      const range = frame.scrollWidth - frame.clientWidth;
      const progress =
        range > 0 ? Math.min(1, Math.max(0, frame.scrollLeft / range)) : 0;
      return [
        ...frame.querySelectorAll<HTMLElement>(":scope > [data-pane]"),
      ].map((pane) => ({
        pane,
        away: pane.dataset.pane === "left" ? progress : 1 - progress,
      }));
    };
    /** A pane's tap target takes a press or focus only while the pane is mostly out of view. */
    const reach = (pane: HTMLElement, out: boolean) => {
      const show = pane.querySelector<HTMLElement>(
        ":scope > [data-depth-show]",
      );
      if (!show) return;
      const press = out ? "auto" : "none";
      if (show.style.pointerEvents !== press)
        show.style.setProperty("pointer-events", press);
      if (show.inert === out) show.inert = !out;
    };
    // Each pane a step back as far as it is out of view. Where the browser has scroll timelines,
    // the stylesheet scales and tints it on the compositor, and an observer tells when it crosses
    // halfway, so nothing here runs while a finger moves: even reading the frame's scroll then
    // would make the page lay out again each frame. Elsewhere this sets both, at most once a frame.
    const place = () => {
      painting = 0;
      for (const { pane, away } of panes()) {
        if (!scrollTimelines) {
          pane.style.setProperty(
            "transform",
            `scale(${1 - depth.scale * away})`,
          );
          pane
            .querySelector<HTMLElement>(":scope > [data-depth-tint]")
            ?.style.setProperty("opacity", String(depth.tint * away));
        }
        reach(pane, away > 0.5);
      }
    };
    const placeSoon = () => {
      if (!scrollTimelines && !painting)
        painting = requestAnimationFrame(place);
    };
    // Half a pane in view or less: out.
    const halfway = scrollTimelines
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries)
              if (entry.target instanceof HTMLElement)
                reach(entry.target, entry.intersectionRatio < 0.5);
          },
          { root: frame, threshold: [0.5] },
        )
      : null;

    // The panes arrive after the frame, and a phone turning resizes it: each time, the active
    // pane shows, unless a swipe or a glide is under way.
    const align = () => {
      const side = ActivePane.get();
      if (!swiping && !glide && side) {
        const left = offsetOf(frame, side);
        if (Math.abs(frame.scrollLeft - left) > 1)
          frame.scrollTo({ left, behavior: "instant" });
      }
      place();
      if (halfway) for (const { pane } of panes()) halfway.observe(pane);
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

    // A split just opened: its entrance starts once both panes are in the frame.
    const greet = () => enter(frame, latest.current.reduce ?? false);
    greeters.set(frame, greet);

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
      placeSoon();
      if (glide) return;
      swiping = true;
      if (hasScrollEnd) return;
      clearTimeout(timer);
      timer = setTimeout(settle, settleMs);
    };

    // A pane chosen by a tap on it or the address: glide to it, then record it.
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
    // does not, as one on the pane out of view starts the glide.
    const takeOver = () => glide?.cancel();

    frame.addEventListener("scroll", onScroll, { passive: true });
    frame.addEventListener("scrollend", settle);
    frame.addEventListener("touchmove", takeOver, { passive: true });
    frame.addEventListener("wheel", takeOver, { passive: true });
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(painting);
      if (running?.frame === frame) running.stop();
      greeters.delete(frame);
      // Side by side, or once closed, the panes stand as they are.
      for (const { pane } of panes()) {
        pane.style.removeProperty("transform");
        const show = pane.querySelector<HTMLElement>(
          ":scope > [data-depth-show]",
        );
        if (show) show.inert = false;
      }
      glide?.cancel();
      unsubscribe();
      resized.disconnect();
      halfway?.disconnect();
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
  /**
   * How far back a pane wholly out of view sits: as the stylesheet sets it from the scroll, and as
   * a pane coming in holds it until the scroll timeline takes over.
   */
  back: { scale: 1 - depth.scale, tint: depth.tint },
  /** The event the frame gets once a split's entrance is over. */
  enteredEvent,
  /**
   * How long a split's entrance takes, in ms, while one is asked for or under way; 0 otherwise.
   */
  entering: () => (isAsked() || running !== null ? opening.ms : 0),
  /**
   * A person asked for a split: when it shows one pane at a time, it opens with an entrance,
   * which starts from where their folder's card is now. A `held` one waits for `release`.
   */
  opening: (held = false) => {
    const card = document.querySelector<HTMLElement>(
      '[data-slot="folder-card"]',
    );
    asked = {
      at: performance.now(),
      from: card?.getBoundingClientRect() ?? null,
      held,
    };
  },
  /** Starts the held entrance on `frame`, whose panes are laid out already, in its next frame. */
  release: (frame: HTMLElement) => {
    if (!asked?.held) return;
    asked = { ...asked, at: performance.now(), held: false };
    greeters.get(frame)?.();
  },
  /** Drops a held entrance: the press it waited for ended some other way. */
  forget: () => {
    if (asked?.held) asked = null;
  },
} as const;
