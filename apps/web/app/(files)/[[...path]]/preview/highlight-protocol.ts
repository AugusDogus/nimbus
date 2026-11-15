import type { CodeLanguage } from "@/lib/file-kind";

export type HighlightRequest = {
  id: number;
  text: string;
  language: CodeLanguage;
};

/** Colored tokens as parallel arrays of UTF-16 offsets and Sugar High types. */
export type HighlightResponse =
  | {
      type: "tokens";
      id: number;
      starts: Uint32Array<ArrayBuffer>;
      ends: Uint32Array<ArrayBuffer>;
      types: Uint8Array<ArrayBuffer>;
    }
  | { type: "failed"; id: number; message: string };

// Chart colors tint toward the text color so contrast holds in every theme.
const mix = (variable: string) =>
  `color-mix(in oklab, var(${variable}) 65%, var(--foreground))`;

/** Sugar High token type id → highlight name and theme color. */
export const TOKEN_STYLES: Record<number, { name: string; color: string }> = {
  1: { name: "nimbus-code-keyword", color: "var(--primary)" },
  2: { name: "nimbus-code-string", color: mix("--chart-2") },
  3: { name: "nimbus-code-class", color: mix("--chart-4") },
  4: { name: "nimbus-code-property", color: mix("--chart-1") },
  5: { name: "nimbus-code-entity", color: mix("--chart-5") },
  6: { name: "nimbus-code-jsx", color: mix("--chart-3") },
  7: { name: "nimbus-code-sign", color: "var(--muted-foreground)" },
  8: { name: "nimbus-code-comment", color: "var(--muted-foreground)" },
};
