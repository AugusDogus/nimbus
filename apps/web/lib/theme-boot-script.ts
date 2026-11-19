import { BuiltInThemes } from "./built-in-themes";
import { colorSchemeStorageKey } from "./color-scheme-key";
import { themeStorageKey, themeStyleId } from "./theme-preferences";
import { themeColorKeys } from "./vscode-theme";

// Applies the chosen color scheme before the page is painted, as `ColorScheme` does later, and
// again whenever the operating system switches between light and dark, on every page, also those
// that load no theme code. Transitions pause for a frame so colors switch at once.
export const colorSchemeBootScript = `(() => {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    let saved = null;
    try { saved = localStorage.getItem(${JSON.stringify(colorSchemeStorageKey)}); } catch {}
    const scheme = saved === 'light' || saved === 'dark' ? saved : system.matches ? 'dark' : 'light';
    if (root.classList.contains(scheme) && root.style.colorScheme === scheme) return false;
    root.classList.remove('light', 'dark');
    root.classList.add(scheme);
    root.style.colorScheme = scheme;
    return true;
  };
  apply();
  system.addEventListener('change', () => {
    const pause = document.createElement('style');
    pause.textContent = '*,*::before,*::after{transition:none!important}';
    document.head.append(pause);
    if (apply()) getComputedStyle(document.body);
    setTimeout(() => pause.remove(), 1);
  });
})();`;

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

// Keeps the browser and installed-app title bar color in step with the selected
// theme, including imported themes, without shipping React code. It reads the
// computed background only when the theme class or the custom theme style
// changes, never on ordinary page updates.
export const themeColorScript = `(() => {
  const root = document.documentElement;
  const sync = () => {
    const color = getComputedStyle(root).getPropertyValue('--background').trim();
    if (!color) return;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.removeAttribute('media');
      if (meta.content !== color) meta.content = color;
    }
  };
  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
  const custom = document.getElementById(${JSON.stringify(themeStyleId)});
  if (custom) observer.observe(custom, { childList: true, characterData: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync, { once: true });
  addEventListener('load', sync, { once: true });
  sync();
})();`;

/**
 * The page's only script that runs before the app: it loads render-blocking in `<head>`, after
 * the custom theme style element and the theme-color meta tags it updates.
 */
export const themeBoot = [
  colorSchemeBootScript,
  themeBootScript,
  themeColorScript,
].join("\n");
