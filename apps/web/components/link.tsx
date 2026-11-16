import { Link as RouterLink, type LinkComponent } from "@tanstack/react-router";

/**
 * The router's link, marked current (`aria-current="page"`) only on the page it names rather
 * than on every page below it.
 */
export const Link: LinkComponent<"a"> = (props) => (
  <RouterLink activeOptions={{ exact: true }} {...props} />
);
