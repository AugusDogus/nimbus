import { useEffect } from "react";
import { ThemePreferences, themeStyleId } from "@/lib/theme-preferences";
import { useThemePreferences } from "@/lib/theme-store";

export function CustomThemeStyles() {
  const snapshot = useThemePreferences();
  useEffect(() => {
    if (snapshot.status === "loading") return;
    const style = document.getElementById(themeStyleId);
    if (style)
      style.textContent =
        snapshot.status === "ready" ? ThemePreferences.css(snapshot.value) : "";
  }, [snapshot]);
  return null;
}
