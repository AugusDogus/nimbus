import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The place in the header, beside the account menu, where a page puts tools of its own, such as
 * the folder pages' split view toggle. Their code then loads with the page that has them.
 */
export const HeaderToolsSlot = createContext<HTMLElement | null>(null);

/** Renders `children` in the header's tools place. */
export function HeaderTools({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderToolsSlot);
  return slot ? createPortal(children, slot) : null;
}
