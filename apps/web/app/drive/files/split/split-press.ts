import { AppFrame } from "@/components/app-frame";
import type { SplitLayout } from "../split-layout";
import { SplitRoom } from "../split-room";
import { ActivePane } from "./active-pane";
import { plannedSplit } from "./open-split";
import { SplitMemory } from "./split-memory";
import { SwipePanes } from "./swipe-panes";

/** How long a press may last before it no longer counts as a tap, in ms. */
const pressMs = 1000;
/** How far a finger may move before its press no longer counts as a tap, in px. */
const slop = 10;

/** What a press on a phone folder's Split acts through: the page's frame and its split. */
export type PressTarget = {
  /** The page's folder frame, which the split fills. */
  frame: HTMLElement;
  /** The folder the split opens beside. */
  left: string;
  /** Shows `layout` as the page's split before its address is written, or the folder alone again. */
  hold: (layout: SplitLayout | null) => void;
  /** Writes the shown split's address and opens it for good, after its first moving frame. */
  open: (layout: SplitLayout) => void;
};

type Press = {
  target: PressTarget;
  pointerId: number;
  start: { x: number; y: number };
  /** The button pressed, where it was: a finger lifting outside it does not tap it. */
  button: DOMRect;
  /** The split prepared, and the copy of the folder over it; null until then. */
  held: { layout: SplitLayout; cover: HTMLElement; focused: boolean } | null;
  timer: ReturnType<typeof setTimeout>;
  stop: () => void;
};

let current: Press | null = null;

/** Whether a split is shown only for a press that may still come to nothing. */
const holding = () => (current?.held ?? null) !== null;

/**
 * A still copy of the frame as it is, laid over it while the split is prepared out of sight
 * beneath: the same elements and classes in the same place, so the page looks the same. Nothing
 * in it acts: the press's own click is taken before it reaches the copy (see `start`).
 */
function coverFor(frame: HTMLElement): HTMLElement | null {
  const cover = frame.cloneNode(true);
  if (!(cover instanceof HTMLElement)) return null;
  cover.removeAttribute("id");
  for (const element of cover.querySelectorAll("[id]"))
    element.removeAttribute("id");
  cover.setAttribute("aria-hidden", "true");
  cover.dataset.splitPressCover = "";
  for (const image of cover.querySelectorAll("img")) image.decoding = "sync";
  const box = frame.getBoundingClientRect();
  Object.assign(cover.style, {
    position: "absolute",
    margin: "0",
    width: `${box.width}px`,
  });
  frame.after(cover);
  const origin = (
    cover.offsetParent ?? document.documentElement
  ).getBoundingClientRect();
  cover.style.left = `${box.left - origin.left}px`;
  cover.style.top = `${box.top - origin.top}px`;
  // Where the copy's card lands may differ from the frame's own box, as margins that fold through
  // the frame stay inside the copy: it moves by however far its card is from the folder's.
  const card = frame
    .querySelector('[data-slot="folder-card"]')
    ?.getBoundingClientRect();
  const copied = cover
    .querySelector('[data-slot="folder-card"]')
    ?.getBoundingClientRect();
  if (card && copied) {
    cover.style.left = `${box.left - origin.left + card.left - copied.left}px`;
    cover.style.top = `${box.top - origin.top + card.top - copied.top}px`;
  }
  return cover;
}

function finish(press: Press) {
  clearTimeout(press.timer);
  press.stop();
  if (current === press) current = null;
}

/** The press came to nothing: the page goes back to the folder alone, as it was, unseen. */
function cancel(press: Press) {
  finish(press);
  if (!press.held) return;
  const { cover, focused } = press.held;
  const scroll = window.scrollY;
  press.target.hold(null);
  SwipePanes.forget();
  if (window.scrollY !== scroll)
    window.scrollTo({ top: scroll, behavior: "instant" });
  press.target.frame.style.removeProperty("opacity");
  cover.remove();
  if (focused)
    press.target.frame
      .querySelector<HTMLElement>('[data-shape="split-button"]')
      ?.focus({ preventScroll: true });
}

/** Prepares the split out of sight, the folder shown as it was over it. */
function prepare(press: Press) {
  const { frame, left, hold } = press.target;
  const layout = plannedSplit(left, null);
  const focused = frame.contains(document.activeElement);
  SwipePanes.opening(true);
  const cover = coverFor(frame);
  if (!cover) return SwipePanes.forget();
  // Laid out, and out of sight until the press taps; the frame's opacity, which its contents do
  // not inherit, so showing it styles nothing in them again.
  frame.style.setProperty("opacity", "0");
  press.held = { layout, cover, focused };
  hold(layout);
}

/** The press tapped: the prepared split shows and starts its entrance in the next frame. */
function release(press: Press) {
  finish(press);
  if (!press.held) return;
  const { layout, cover } = press.held;
  const { frame, open } = press.target;
  ActivePane.set(layout.active);
  frame.style.removeProperty("opacity");
  cover.remove();
  SwipePanes.release(frame);
  // The address and the remembered split once that frame is drawn: the compositor carries the
  // motion on from there.
  requestAnimationFrame(() =>
    setTimeout(() => {
      SplitMemory.write({ right: layout.right, ratio: layout.ratio });
      open(layout);
    }),
  );
}

/**
 * A finger on a phone folder's Split. Split opens on the tap, as any button does, but what it
 * shows is prepared as the finger goes down: the split's panes laid out out of sight beneath a
 * still copy of the folder, so the tap only has to show them and start their entrance. A tap
 * that comes while that is under way waits for it, as for any work on the page, and then opens
 * the prepared split.
 *
 * Nothing on screen changes until the tap. A press that does not end in one, as when the finger
 * slides off, scrolls, holds, or lifts without a click, puts the folder back as it was, and has
 * written no address, active pane or remembered split. A press that prepared nothing, as where
 * the split would show both panes, leaves its tap to open the split as it always has.
 */
function start(event: PointerEvent, button: HTMLElement, target: PressTarget) {
  if (current) cancel(current);
  const area = target.frame.parentElement;
  if (
    event.pointerType !== "touch" ||
    !event.isPrimary ||
    area === null ||
    SplitRoom.mode(SplitRoom.contentWidth(area), AppFrame.sidebarRem * 16) !==
      "swipe"
  )
    return;
  const controller = new AbortController();
  const press: Press = {
    target,
    pointerId: event.pointerId,
    start: { x: event.clientX, y: event.clientY },
    button: button.getBoundingClientRect(),
    held: null,
    timer: setTimeout(() => cancel(press), pressMs),
    stop: () => controller.abort(),
  };
  current = press;
  const outside = (x: number, y: number) =>
    Math.hypot(x - press.start.x, y - press.start.y) > slop ||
    x < press.button.left ||
    x > press.button.right ||
    y < press.button.top ||
    y > press.button.bottom;
  const options = { capture: true, signal: controller.signal };
  document.addEventListener(
    "pointermove",
    (move) => {
      if (
        move.pointerId === press.pointerId &&
        outside(move.clientX, move.clientY)
      )
        cancel(press);
    },
    options,
  );
  document.addEventListener(
    "pointerup",
    (up) => {
      if (up.pointerId === press.pointerId && outside(up.clientX, up.clientY))
        cancel(press);
    },
    options,
  );
  document.addEventListener(
    "pointercancel",
    (lost) => {
      if (lost.pointerId === press.pointerId) cancel(press);
    },
    options,
  );
  // A long press, or another finger, which might land on the split held out of sight.
  document.addEventListener("contextmenu", () => cancel(press), options);
  document.addEventListener(
    "pointerdown",
    (down) => {
      if (down.pointerId !== press.pointerId) cancel(press);
    },
    options,
  );
  // The window itself losing focus, not an element in it, as the button does once the split is
  // prepared in its place.
  window.addEventListener(
    "blur",
    (blur) => {
      if (blur.target === window) cancel(press);
    },
    { signal: controller.signal },
  );
  document.addEventListener(
    "click",
    (click) => {
      if (!press.held) {
        // Nothing was prepared: the click opens the split as it would anyway.
        finish(press);
        return;
      }
      // Its own: the copy took it, which no button may act on.
      click.preventDefault();
      click.stopPropagation();
      release(press);
    },
    options,
  );
  // At once, so it is ready however short the tap. The button shows pressed as it always has: on
  // the copy, under the finger from here on, which has the same look.
  prepare(press);
}

export const SplitPress = { start, holding } as const;
