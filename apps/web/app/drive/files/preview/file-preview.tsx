import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { lazyComponent } from "@/components/lazy-component";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileKind } from "@/lib/file-kind";
import type { EditBase } from "./text-editor";
import { TEXT_LIMIT, TextContent } from "./text-content";

export type FilePreviewProps = {
  name: string;
  /** Inline preview URL; it serves text as text/plain under a sandbox CSP. */
  url: string;
  /** Present when the viewer may write this file. */
  editPath?: string;
  /** Reports whether unsaved edits exist, so the dialog can guard closing. */
  onDirtyChange?: (dirty: boolean) => void;
};

const frame =
  "max-h-[65dvh] min-h-40 w-full overflow-auto rounded-md border bg-muted";

function Unavailable({ children }: { children: ReactNode }) {
  return (
    <p className="text-pretty text-sm text-muted-foreground">{children}</p>
  );
}

const loading = (
  <Skeleton
    aria-label="Loading preview"
    className="h-[min(65dvh,32rem)] w-full"
  />
);

const pdfLoading = (
  <Skeleton aria-label="Loading preview" className="h-[65dvh] w-full" />
);

const MarkdownView = lazyComponent(() => import("./markdown-view"), loading);
const CodeView = lazyComponent(() => import("./code-view"), loading);
const TableView = lazyComponent(() => import("./table-view"), loading);
const TextEditor = lazyComponent(() => import("./text-editor"), loading);
const PdfPagesView = lazyComponent(
  () => import("./pdf-pages-view"),
  pdfLoading,
);

export default function FilePreview({
  name,
  url,
  editPath,
  onDirtyChange,
}: FilePreviewProps) {
  const kind = FileKind.of(name);
  const [failed, setFailed] = useState(false);
  if (FileKind.isText(kind))
    return (
      <TextPreview
        kind={kind}
        url={url}
        editPath={editPath}
        onDirtyChange={onDirtyChange}
      />
    );
  if (failed)
    return (
      <Unavailable>
        Your browser cannot display this file. Download it to open it on your
        device.
      </Unavailable>
    );
  // Native elements keep browser zoom, playback, captions and accessibility.
  switch (kind.type) {
    case "image":
      return (
        <div className="flex justify-center rounded-md bg-muted">
          {/* The original bytes, as the browser decodes them natively. */}
          <img
            src={url}
            alt={name}
            decoding="async"
            onError={() => setFailed(true)}
            className="h-auto max-h-[65dvh] w-auto max-w-full object-contain"
          />
        </div>
      );
    case "video":
      return (
        <video
          controls
          playsInline
          preload="metadata"
          src={url}
          onError={() => setFailed(true)}
          className="max-h-[65dvh] w-full rounded-md bg-black"
        >
          <track kind="captions" />
        </video>
      );
    case "audio":
      return (
        <audio
          controls
          preload="metadata"
          src={url}
          onError={() => setFailed(true)}
          className="w-full"
        />
      );
    case "pdf":
      return <PdfPreview name={name} url={url} />;
    case "other":
    default:
      return (
        <Unavailable>
          A preview is not available for this file type. Download it to open it
          on your device.
        </Unavailable>
      );
  }
}

const subscribe = () => () => {};

/**
 * The browser's own PDF viewer where it can show one in a frame, which keeps its search, zoom
 * and text selection. Elsewhere, such as Chrome on Android, a framed PDF becomes a download
 * prompt, so the server renders the pages instead. Unknown in markup rendered by the server.
 */
const usePdfViewer = () =>
  useSyncExternalStore(
    subscribe,
    () => (navigator.pdfViewerEnabled ? "native" : "pages"),
    () => "unknown",
  );

function PdfPreview({ name, url }: { name: string; url: string }) {
  const viewer = usePdfViewer();
  return (
    <div className="space-y-2">
      {viewer === "native" ? (
        <iframe
          title={`Preview of ${name}`}
          src={url}
          className="h-[65dvh] w-full rounded-md border bg-muted"
        />
      ) : viewer === "pages" ? (
        <PdfPagesView name={name} url={url} />
      ) : (
        pdfLoading
      )}
      <a
        href={url}
        target="_blank"
        rel="noopener"
        className={buttonVariants({
          variant: "link",
          className: "h-auto p-0",
        })}
      >
        Open in a new tab
      </a>
    </div>
  );
}

type TextMode =
  | { type: "view" }
  | { type: "source" }
  | { type: "edit"; base: EditBase };

function TextPreview({
  kind,
  url,
  editPath,
  onDirtyChange,
}: {
  kind: FileKind;
  url: string;
  editPath?: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["preview", url];
  const [mode, setMode] = useState<TextMode>({ type: "view" });
  // Leaving the editor unmounts the button that closed it, so focus returns to Edit.
  const refocusEdit = useRef(false);
  const leaveEditor = () => {
    onDirtyChange?.(false);
    refocusEdit.current = true;
    setMode({ type: "view" });
  };
  const content = useQuery({
    queryKey,
    queryFn: ({ signal }) => TextContent.load(url, signal),
    staleTime: 0,
    gcTime: 0,
    // The editor works from the text it started with; refetches would only be discarded.
    enabled: mode.type !== "edit",
  });
  // Rendered before the query's state: a failed refetch or a file that grew must not unmount
  // the editor and lose the draft.
  if (mode.type === "edit" && editPath !== undefined)
    return (
      <TextEditor
        path={editPath}
        base={mode.base}
        language={kind.type === "code" ? kind.language : undefined}
        onDirtyChange={onDirtyChange}
        onSaved={({ text, etag, size }) =>
          queryClient.setQueryData<TextContent>(queryKey, {
            type: "text",
            text,
            size,
            truncated: false,
            encoding: "utf-8",
            etag,
          })
        }
        onClose={leaveEditor}
        onDiscard={() => {
          void queryClient.invalidateQueries({ queryKey, exact: true });
          leaveEditor();
        }}
      />
    );
  if (content.isPending) return loading;
  if (content.isError)
    return (
      <p role="alert" className="text-pretty text-sm">
        {content.error.message}
      </p>
    );
  const data = content.data;
  if (data.type === "binary")
    return (
      <Unavailable>
        This file contains binary data and cannot be shown as text. Download it
        to open it on your device.
      </Unavailable>
    );
  const editBase =
    editPath !== undefined &&
    !data.truncated &&
    data.encoding === "utf-8" &&
    data.etag !== null
      ? { text: data.text, etag: data.etag }
      : null;
  const view =
    kind.type === "markdown" && mode.type === "view" ? (
      <MarkdownView text={data.text} />
    ) : kind.type === "table" && mode.type === "view" ? (
      <TableView text={data.text} delimiter={kind.delimiter} />
    ) : kind.type === "code" ? (
      <CodeView text={data.text} language={kind.language} />
    ) : (
      <pre className="whitespace-pre-wrap break-words p-4 font-mono text-sm">
        {data.text}
      </pre>
    );
  const hasRendered = kind.type === "markdown" || kind.type === "table";
  return (
    <div className="space-y-2">
      <div className={frame} data-preview-scroll>
        {view}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {data.truncated && (
          <p className="text-pretty">
            Showing the first {TEXT_LIMIT / 1024 / 1024} MB. Download the file
            to see all of it.
            {editPath !== undefined &&
              ` Files up to ${TEXT_LIMIT / 1024 / 1024} MB can be edited here.`}
          </p>
        )}
        {data.encoding === "other" && (
          <p className="text-pretty">
            This file is not UTF-8 text, so some characters show as �. It can’t
            be edited here, because saving would change those characters.
          </p>
        )}
        <div className="ml-auto flex gap-2">
          {hasRendered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setMode({ type: mode.type === "source" ? "view" : "source" })
              }
            >
              {mode.type === "source" ? "Show formatted" : "Show source"}
            </Button>
          )}
          {editBase && (
            <Button
              ref={(button) => {
                if (!button || !refocusEdit.current) return;
                refocusEdit.current = false;
                button.focus();
              }}
              variant="outline"
              size="sm"
              onClick={() => setMode({ type: "edit", base: editBase })}
            >
              Edit
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
