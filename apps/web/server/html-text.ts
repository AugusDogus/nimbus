/** Text placed in HTML the server writes itself, outside React. */
export const HtmlText = {
  /** `value` as HTML text or a quoted attribute value: markup in it shows as written. */
  escape: (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;"),
} as const;
