import * as z from "zod/mini";

/**
 * The icon set an account uses, as the browser needs it: the set's id and its manifest's URL,
 * or no manifest for Nimbus's own icons. Browsers keep the last answer to draw icons at once on
 * the next load, then check it with the server.
 */
const schema = z.object({
  id: z.string().check(z.minLength(1), z.maxLength(100)),
  manifest: z.nullable(
    z
      .string()
      .check(
        z.regex(/^\/api\/icon-themes\/[\w.-]+\/manifest-[a-f0-9]{16}\.json$/),
      ),
  ),
});
export type IconChoice = z.infer<typeof schema>;

export const iconChoiceStorageKey = "nimbus-icon-theme-v1";

export const IconChoice = {
  schema,
  parse(value: unknown): IconChoice | null {
    const result = schema.safeParse(value);
    return result.success ? result.data : null;
  },
  /** The cached choice in this browser, or null. */
  cached(): IconChoice | null {
    try {
      const raw = localStorage.getItem(iconChoiceStorageKey);
      return raw === null ? null : IconChoice.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  },
  cache(choice: IconChoice) {
    try {
      localStorage.setItem(iconChoiceStorageKey, JSON.stringify(choice));
    } catch {
      // Without storage the next load asks the server first; icons still show.
    }
  },
} as const;
