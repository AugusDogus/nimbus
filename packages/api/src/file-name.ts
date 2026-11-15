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
