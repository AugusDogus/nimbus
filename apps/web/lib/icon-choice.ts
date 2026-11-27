/**
 * The icon set an account uses, as the browser needs it: the set's id and its manifest's URL,
 * or no manifest for Nimbus's own icons. Browsers keep the last answer to draw icons at once on
 * the next load, then check it with the server. Parsed by hand: every page's entry reads it,
 * and no validator ships there.
 */
export type IconChoice = { id: string; manifest: string | null };

export const iconChoiceStorageKey = "nimbus-icon-theme-v1";

const manifestUrl =
  /^\/api\/icon-themes\/[\w.-]+\/manifest-[a-f0-9]{16}\.json$/;

function parse(value: unknown): IconChoice | null {
  if (typeof value !== "object" || value === null) return null;
  const id: unknown = Reflect.get(value, "id");
  const manifest: unknown = Reflect.get(value, "manifest");
  return typeof id === "string" &&
    id.length > 0 &&
    id.length <= 100 &&
    (manifest === null ||
      (typeof manifest === "string" && manifestUrl.test(manifest)))
    ? { id, manifest }
    : null;
}

export const IconChoice = {
  parse,
  /** The cached choice in this browser, or null. */
  cached(): IconChoice | null {
    try {
      const raw = localStorage.getItem(iconChoiceStorageKey);
      return raw === null ? null : parse(JSON.parse(raw));
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
