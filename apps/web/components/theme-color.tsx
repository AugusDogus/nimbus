import { themeStyleId } from "@/lib/theme-preferences";

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

export function ThemeColor({ nonce }: { nonce: string | undefined }) {
  // Browsers hide nonce attributes after parsing, so hydration sees an empty value.
  return <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeColorScript }} />;
}
