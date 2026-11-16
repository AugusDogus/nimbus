/**
 * JSON for an inline `<script type="application/json">`. Escaping `<` keeps the data from
 * closing the element, and the line separators are escaped for older parsers.
 */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/** The parsed JSON of the element `id`, or undefined when it is missing or malformed. */
export function readInlineJson(id: string): unknown {
  const text = document.getElementById(id)?.textContent;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
