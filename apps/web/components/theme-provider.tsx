import { lazy, Suspense, type ReactNode } from "react";

// The boot script applies saved themes before the first paint. This keeps them in step with
// later changes, so it loads after the page instead of with it.
const CustomThemeStyles = lazy(() =>
  import("./custom-theme-styles").then((module) => ({
    default: module.CustomThemeStyles,
  })),
);

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Suspense fallback={null}>
        <CustomThemeStyles />
      </Suspense>
    </>
  );
}
