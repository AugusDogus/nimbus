import { EditLimits } from "@/lib/edit-limits";

/** The first bytes of a file, decoded for the text viewer and editor. */
export type TextContent =
  | {
      type: "text";
      text: string;
      /** Total size on the server, which may exceed what was loaded. */
      size: number;
      /** True when only the first `TEXT_LIMIT` bytes were loaded. */
      truncated: boolean;
      /**
       * `other` when the bytes are not valid UTF-8. The text then shows replacement
       * characters, and saving it would replace the original bytes, so it is read-only.
       */
      encoding: "utf-8" | "other";
      etag: string | null;
    }
  | { type: "binary"; size: number };

/** What a preview loads, which is also the largest file the editor opens. */
export const TEXT_LIMIT = EditLimits.open;

const totalSize = (response: Response, loaded: number) => {
  const range = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  return range ? Number(range[1]) : loaded;
};

/** NUL bytes never occur in UTF-8 text; their presence means a binary file. */
const looksBinary = (bytes: Uint8Array) => bytes.subarray(0, 8192).includes(0);

export const TextContent = {
  async load(url: string, signal?: AbortSignal): Promise<TextContent> {
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` },
      cache: "no-store",
      signal,
    });
    const etag = response.headers.get("etag");
    if (
      response.status === 416 &&
      response.headers.get("content-range") === "bytes */0"
    )
      return {
        type: "text",
        text: "",
        size: 0,
        truncated: false,
        encoding: "utf-8",
        etag,
      };
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? "This file no longer exists. Refresh the folder to see its current contents."
          : "The preview could not be loaded. The file is unchanged; download it to open it on your device.",
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const size = totalSize(response, bytes.byteLength);
    if (looksBinary(bytes)) return { type: "binary", size };
    const truncated = size > bytes.byteLength;
    const decode = (fatal: boolean) =>
      // Streaming mode holds back a multi-byte character cut by the range. A byte order mark
      // stays in the text, so saving writes it back.
      new TextDecoder("utf-8", { fatal, ignoreBOM: true }).decode(bytes, {
        stream: truncated,
      });
    try {
      return {
        type: "text",
        text: decode(true),
        size,
        truncated,
        encoding: "utf-8",
        etag,
      };
    } catch {
      return {
        type: "text",
        text: decode(false),
        size,
        truncated,
        encoding: "other",
        etag,
      };
    }
  },
} as const;
