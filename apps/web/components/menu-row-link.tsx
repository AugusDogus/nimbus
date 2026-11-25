import {
  cloneElement,
  createRef,
  type AnchorHTMLAttributes,
  type ReactElement,
  type Ref,
} from "react";

type LinkElement = ReactElement<
  AnchorHTMLAttributes<HTMLAnchorElement> & { ref?: Ref<HTMLAnchorElement> }
>;

/**
 * Fluid Functionalism's menu rows are not links. A row that goes somewhere spreads these onto its
 * `MenuItem`: the link is laid over the whole row through the row's `leading` slot, so a middle or
 * modified click opens a new tab, hovering shows the address and right-click offers the browser's
 * link menu, as when the row was the link. A plain click follows the link; choosing the row from
 * the keyboard clicks it. `onFollow` runs on a pointer click, which the row itself never hears, so
 * it can close the menu.
 */
export function menuRowLink(link: LinkElement, onFollow?: () => void) {
  const anchor = createRef<HTMLAnchorElement>();
  return {
    onSelect: () => anchor.current?.click(),
    leading: cloneElement(link, {
      ref: anchor,
      tabIndex: -1,
      "aria-hidden": true,
      className: "absolute inset-0 z-10 rounded-[inherit]",
      onClick: onFollow,
    }),
    // The empty slot would add the row's gap before its icon; this takes it back.
    className: "[&>span:first-child]:-me-2",
  };
}
