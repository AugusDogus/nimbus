import "react";

// Inline styles set CSS custom properties, such as `--sidebar-width`, which React's
// CSSProperties does not list. Typing them here keeps `style` objects free of casts.
declare module "react" {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}
