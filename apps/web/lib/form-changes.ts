import { useState, type InputEvent } from "react";

/** Whether `field` holds something other than what the page gave it: typed, ticked or chosen. */
function fieldChanged(field: Element): boolean {
  if (field instanceof HTMLInputElement) {
    if (field.type === "checkbox" || field.type === "radio")
      return field.checked !== field.defaultChecked;
    if (field.type === "file") return (field.files?.length ?? 0) > 0;
    return field.value !== field.defaultValue;
  }
  if (field instanceof HTMLTextAreaElement)
    return field.value !== field.defaultValue;
  if (field instanceof HTMLSelectElement)
    return [...field.options].some(
      (option) => option.selected !== option.defaultSelected,
    );
  return false;
}

/**
 * Whether a form whose fields keep their own values (read on submit, not held in state) differs
 * from how it opened. Pass `onInput` to the form; `changed` follows every edit, and goes back to
 * false when the fields are put back as they were. A dialog that stays mounted between openings
 * calls `reset` as it closes.
 */
export function useFormChanges() {
  const [changed, setChanged] = useState(false);
  return {
    changed,
    onInput: (event: InputEvent<HTMLFormElement>) =>
      setChanged([...event.currentTarget.elements].some(fieldChanged)),
    reset: () => setChanged(false),
  };
}
