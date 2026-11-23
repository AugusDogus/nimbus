/** Every hold placed on leaving the page, while it lasts. */
const holds = new Set<symbol>();
let leaving = false;
const warn = (event: BeforeUnloadEvent) => {
  if (!leaving) event.preventDefault();
};

/**
 * Work that leaving or reloading the page would lose, or leave without a report: running
 * uploads, moves and copies, and unsaved editor text. While any is held the browser asks before
 * the page is left, and signing out asks first (see `busy`).
 */
export const LeaveGuard = {
  /** Hold the page while the work runs; call the returned function when it is done. */
  hold(): () => void {
    const token = Symbol("leave-guard");
    if (holds.size === 0) addEventListener("beforeunload", warn);
    holds.add(token);
    return () => {
      if (!holds.delete(token)) return;
      if (holds.size === 0) removeEventListener("beforeunload", warn);
    };
  },
  busy: () => holds.size > 0,
  /** Go to `href` without the browser asking again, once the person has chosen to. */
  leave(href: string) {
    leaving = true;
    location.assign(href);
  },
} as const;
