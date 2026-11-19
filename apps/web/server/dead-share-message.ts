/**
 * Why a link no longer opens, as its visitors read it on the page and from the share endpoint.
 * None names the item, its path or its owner. `unknown` covers every token with no record,
 * issued or not, so a guessed token learns nothing.
 */
export const DeadShareMessage = {
  expired:
    "This link has expired, so it no longer opens. Ask the person who shared it for a new link.",
  revoked:
    "The person who shared this link turned it off, so it no longer opens. Ask them for a new link if you still need it.",
  exhausted:
    "This link has reached its download limit, so it no longer opens. Ask the person who shared it for a new link.",
  unknown:
    "This link does not open. Check that you have the whole address, or ask the person who shared it for a new link.",
} as const;
