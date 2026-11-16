"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";
import { CustomThemeStyles } from "./custom-theme-styles";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider {...props}>
      <CustomThemeStyles />
      {children}
    </NextThemesProvider>
  );
}
