import type { ReactNode } from "react";
import { lazyComponent } from "@/components/lazy-component";

// The boot script applies saved themes before the first paint. This keeps them in step with
// later changes, so it loads after the page instead of with it.
const CustomThemeStyles = lazyComponent<object>(async () => ({
  default: (await import("./custom-theme-styles")).CustomThemeStyles,
}));

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <CustomThemeStyles />
    </>
  );
}
