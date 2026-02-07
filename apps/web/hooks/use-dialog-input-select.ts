import { useCallback, useRef } from "react";

/**
 * Hook for controlling text selection inside a Radix Dialog input.
 *
 * Radix's FocusScope calls `element.select()` directly on the DOM node
 * when trapping focus, which always selects the full value. This hook
 * overrides `.select()` on the input element so it applies a custom
 * selection range instead. The override is automatically removed on the
 * first user interaction (pointer or keyboard) so normal behavior is
 * restored afterward.
 *
 * Returns `inputRef` (a ref callback for the input) and
 * `handleOpenAutoFocus` (pass to `DialogContent`'s `onOpenAutoFocus`).
 *
 * @param getSelectionRange - Given the input value, return `[start, end]`
 *   for the desired selection. Return `null` to fall back to select-all.
 */
export function useDialogInputSelect(
  getSelectionRange: (value: string) => [start: number, end: number] | null,
) {
  const ref = useRef<HTMLInputElement>(null);

  const inputRef = useCallback(
    (node: HTMLInputElement | null) => {
      ref.current = node;
      if (!node) return;

      const originalSelect = node.select.bind(node);

      node.select = () => {
        const range = getSelectionRange(node.value);
        if (range) {
          node.setSelectionRange(range[0], range[1]);
        } else {
          originalSelect();
        }
      };

      const restore = () => {
        node.select = originalSelect;
        node.removeEventListener("pointerdown", restore);
        node.removeEventListener("keydown", restore);
      };
      node.addEventListener("pointerdown", restore);
      node.addEventListener("keydown", restore);
    },
    [getSelectionRange],
  );

  const handleOpenAutoFocus = useCallback((e: Event) => {
    e.preventDefault();
    const input = ref.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  return { inputRef, handleOpenAutoFocus };
}
