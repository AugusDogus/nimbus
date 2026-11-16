import { useLocation } from "@tanstack/react-router";

/** The path of the current address, such as `/settings/account`. */
export const usePathname = () =>
  useLocation({ select: (location) => location.pathname });
