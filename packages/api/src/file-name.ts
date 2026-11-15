import { z } from "zod";

export const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      !/[\\/\x00-\x1f]/.test(name) &&
      ![".", "..", ".nimbus"].includes(name.toLowerCase()),
    "Choose a name without slashes or control characters. The name .nimbus is reserved.",
  );

/** `name`, then `name (1)`, `name (2)`: the suffix sits before a file's extension. */
export function numberedName(name: string, index: number, isFile: boolean) {
  if (index === 0) return name;
  const dot = isFile ? name.lastIndexOf(".") : -1;
  return dot > 0
    ? `${name.slice(0, dot)} (${index})${name.slice(dot)}`
    : `${name} (${index})`;
}
