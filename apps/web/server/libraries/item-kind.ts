import { FileKind } from "@/lib/file-kind";
import { LIBRARY_ITEM_KINDS, type LibraryItemKind } from "../db/library-schema";

/**
 * What a library item is, from its file name, with the Content-Type Nimbus serves it as. It
 * follows the table every preview and download uses, so clients and the web app agree.
 */
export type ItemKind = { kind: LibraryItemKind; contentType: string };

const kindOf: Record<FileKind["type"], LibraryItemKind> = {
  video: "video",
  audio: "audio",
  image: "image",
  pdf: "document",
  markdown: "document",
  table: "document",
  code: "document",
  text: "document",
  other: "other",
};

export const ItemKind = {
  of(name: string): ItemKind {
    const kind = FileKind.of(name);
    return {
      kind: kindOf[kind.type],
      contentType: FileKind.previewContentType(kind),
    };
  },
  /** The kinds in a `kinds` query, such as `video,document`, or null when one is unknown. */
  parseList(value: string): LibraryItemKind[] | null {
    const kinds: LibraryItemKind[] = [];
    for (const part of value.split(",")) {
      const kind = LIBRARY_ITEM_KINDS.find((known) => known === part.trim());
      if (kind === undefined) return null;
      if (!kinds.includes(kind)) kinds.push(kind);
    }
    return kinds;
  },
} as const;
