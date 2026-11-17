import { useCallback } from "react";

/**
 * A ref for a controlled field the server rendered. Whatever was typed or autofilled into it
 * before the page's code ran is still in the field when React takes it over, but not in the
 * form's state; this hands it to `setValue` then, so the form holds what the field shows.
 */
export function useServerField(setValue: (value: string) => void) {
  return useCallback(
    (input: HTMLInputElement | null) => {
      if (input && input.value !== "") setValue(input.value);
    },
    [setValue],
  );
}
