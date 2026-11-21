/**
 * Whether items may move up into the folder above the one shown: not known yet, while what that
 * folder allows is still loading; no; or into which folder.
 */
export type MoveUp =
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "into"; path: string };

const unknown: MoveUp = { kind: "unknown" };
const none: MoveUp = { kind: "none" };

/**
 * What a menu that opened with `atOpen` offers now, so that no item appears or disappears while
 * it is open: Move up shows when it was there at opening, disabled until it can be used, and is
 * not added if the answer arrives later. The next menu opens with the answer.
 */
function steady(atOpen: MoveUp, now: MoveUp): MoveUp {
  if (atOpen.kind === "none") return none;
  return now.kind === "none" ? unknown : now;
}

export const MoveUp = { unknown, none, steady } as const;
