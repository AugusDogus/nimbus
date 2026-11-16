import * as z from "zod/mini";
import type { ThemeResult, VsCodeTheme } from "./vscode-theme";

const extensionSchema = z.object({
  namespace: z.string().check(z.minLength(1), z.maxLength(100)),
  name: z.string().check(z.minLength(1), z.maxLength(100)),
  displayName: z.optional(z.string().check(z.maxLength(200))),
  description: z.optional(z.string().check(z.maxLength(2000))),
  downloadCount: z.optional(z.number().check(z.nonnegative())),
  files: z.object({
    download: z.url().check(
      z.refine((value) => {
        const url = new URL(value);
        return (
          url.origin === "https://open-vsx.org" &&
          url.pathname.startsWith("/api/") &&
          !url.username &&
          !url.password
        );
      }),
    ),
  }),
});
export type OpenVsxExtension = z.infer<typeof extensionSchema>;

async function request(
  url: string,
  limit: number,
  signal: AbortSignal,
): Promise<ThemeResult<Uint8Array>> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok || !response.body)
      return {
        ok: false,
        error: `Open VSX could not complete the request (HTTP ${response.status}). Try again shortly.`,
      };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit)
          return {
            ok: false,
            error:
              "The Open VSX response exceeds the import size limit. Try a smaller extension or import a theme JSON file.",
          };
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { ok: true, value: bytes };
  } catch {
    return {
      ok: false,
      error: signal.aborted
        ? "The theme request was cancelled."
        : "Open VSX could not be reached. Check your connection and try again. Your saved themes are unchanged.",
    };
  }
}

async function search(
  query: string,
  signal: AbortSignal,
): Promise<ThemeResult<OpenVsxExtension[]>> {
  const url = new URL("https://open-vsx.org/api/-/search");
  url.search = new URLSearchParams({
    query: query.trim(),
    category: "Themes",
    size: "12",
    sortBy: "relevance",
  }).toString();
  const response = await request(url.href, 512 * 1024, signal);
  if (!response.ok) return response;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(response.value));
    const result = z
      .object({ extensions: z.array(extensionSchema).check(z.maxLength(12)) })
      .safeParse(value);
    if (result.success) return { ok: true, value: result.data.extensions };
  } catch {
    /* Return a recoverable error for malformed remote data. */
  }
  return {
    ok: false,
    error: "Open VSX returned an unreadable search result. Try again shortly.",
  };
}

async function install(
  extension: OpenVsxExtension,
  signal: AbortSignal,
): Promise<ThemeResult<VsCodeTheme[]>> {
  const validated = extensionSchema.safeParse(extension);
  if (!validated.success)
    return {
      ok: false,
      error:
        "This extension has an invalid download address. Search again and retry.",
    };
  try {
    const { ThemeExtension, maxExtensionBytes } =
      await import("./theme-extension");
    const response = await request(
      validated.data.files.download,
      maxExtensionBytes,
      signal,
    );
    if (!response.ok) return response;
    return ThemeExtension.read(response.value);
  } catch {
    return {
      ok: false,
      error:
        "The theme importer could not load. Check your connection and reload Nimbus. Your saved themes are unchanged.",
    };
  }
}

export const OpenVsxThemes = { search, install } as const;
