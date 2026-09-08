import { themeColorKeys } from "@/lib/vscode-theme";
import { BuiltInThemes } from "@/lib/built-in-themes";
import { themeStorageKey, themeStyleId } from "@/lib/theme-preferences";

// Runs before the page is painted. Only known variables with hex colors may
// become CSS; imported names and source text never become markup or script.
export const themeBootScript = `(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(${JSON.stringify(themeStorageKey)}) || 'null');
    if (!saved || saved.version !== 1 || !Array.isArray(saved.themes) || saved.themes.length > 100) return;
    const keys = ${JSON.stringify(themeColorKeys)};
    const themes = [...${JSON.stringify(BuiltInThemes.all)}, ...saved.themes];
    let css = '';
    for (const mode of ['light', 'dark']) {
      if (typeof saved[mode] !== 'string') continue;
      const theme = themes.find(t => t && t.id === saved[mode] && t.appearance === mode);
      if (!theme || !theme.colors || !keys.every(k => typeof theme.colors[k] === 'string' && /^#[\\da-f]{6}$/i.test(theme.colors[k]))) continue;
      css += ':root.' + mode + '{' + keys.map(k => '--' + k + ':' + theme.colors[k] + ';').join('') + '}';
    }
    document.getElementById(${JSON.stringify(themeStyleId)}).textContent = css;
  } catch { /* The settings page reports unreadable storage after hydration. */ }
})();`;

export function ThemeBoot() {
  return (
    <>
      <style id={themeStyleId} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: "" }} />
      <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
    </>
  );
}
