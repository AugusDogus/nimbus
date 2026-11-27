import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { lazyComponent } from "@/components/lazy-component";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileKind } from "@/lib/file-kind";
import { THUMBNAIL_SIZE } from "@/lib/thumbnail-kind";
import { cn } from "@/lib/utils";
import type { EditBase } from "./text-editor";
import { PreviewShape, TextFrameLoading } from "./preview-shape";
import { TEXT_LIMIT, TextContent } from "./text-content";

export type FilePreviewProps = {
  name: string;
  /** Inline preview URL; it serves text as text/plain under a sandbox CSP. */
  url: string;
  /** Present when the viewer may write this file. */
  editPath?: string;
  /** Reports whether unsaved edits exist, so the dialog can guard closing. */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * The file's thumbnail, drawn in the media's own proportions: shown in the media's place, at
   * the size the media will have, until the media can show itself.
   */
  poster?: string;
};

function Unavailable({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center rounded-md bg-muted p-6">
      <p className="max-w-sm text-pretty text-center text-sm text-muted-foreground">
        {children}
      </p>
    </div>
  );
}

const loading = <TextFrameLoading />;
/** A view's code loading inside the text frame, which it fills. */
const inFrame = (
  <Skeleton
    aria-label="Loading preview"
    className="size-full rounded-none motion-reduce:animate-none"
  />
);

const pdfLoading = (
  <Skeleton aria-label="Loading preview" className="min-h-0 w-full flex-1" />
);

const MarkdownView = lazyComponent(() => import("./markdown-view"), inFrame);
const CodeView = lazyComponent(() => import("./code-view"), inFrame);
const TableView = lazyComponent(() => import("./table-view"), inFrame);
const TextEditor = lazyComponent(() => import("./text-editor"), loading);
const PdfPagesView = lazyComponent(
  () => import("./pdf-pages-view"),
  pdfLoading,
);

/** The preview in its stage, which has the same size whatever the file and however it loads. */
export default function FilePreview(props: FilePreviewProps) {
  return (
    <div data-preview-stage className={PreviewShape.stage}>
      <StageContent {...props} />
    </div>
  );
}

function StageContent({
  name,
  url,
  editPath,
  onDirtyChange,
  poster,
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
        <ImagePreview
          name={name}
          url={url}
          poster={poster}
          onError={() => setFailed(true)}
        />
      );
    case "video":
      return (
        // The stage sets its size, which so never follows the video's as it loads. The poster
        // fits as the frames will, and shows until playback starts.
        <video
          controls
          playsInline
          preload="metadata"
          src={url}
          poster={poster}
          onError={() => setFailed(true)}
          className="min-h-0 w-full flex-1 rounded-md bg-black object-contain"
        >
          <track kind="captions" />
        </video>
      );
    case "audio":
      return (
        <div className="flex min-h-0 flex-1 items-center rounded-md bg-muted p-4">
          <audio
            controls
            preload="metadata"
            src={url}
            onError={() => setFailed(true)}
            className="w-full"
          />
        </div>
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

/**
 * How an image fits the stage: enlarged to fill it, or at its own size when smaller than a
 * thumbnail. A thumbnail is never larger than its image, so one this small is the image's own
 * size, and the thumbnail and the image so fit alike.
 */
type Fit = "object-scale-down" | "object-contain";
const fit = (image: HTMLImageElement): Fit =>
  Math.max(image.naturalWidth, image.naturalHeight) < THUMBNAIL_SIZE
    ? "object-scale-down"
    : "object-contain";

/**
 * The original bytes, as the browser decodes them natively, shown once decoded. Until then its
 * thumbnail stands in, fit as the image will be, so the picture only sharpens.
 */
function ImagePreview({
  name,
  url,
  poster,
  onError,
}: {
  name: string;
  url: string;
  poster: string | undefined;
  onError: () => void;
}) {
  const [posterFit, setPosterFit] = useState<Fit | null>(null);
  const [imageFit, setImageFit] = useState<Fit | null>(null);
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-muted">
      {poster !== undefined && imageFit === null && (
        <img
          src={poster}
          alt=""
          aria-hidden
          decoding="async"
          draggable={false}
          onLoad={(event) => setPosterFit(fit(event.currentTarget))}
          className={cn("absolute inset-0 size-full", posterFit ?? "invisible")}
        />
      )}
      <img
        src={url}
        alt={name}
        decoding="async"
        onLoad={(event) => {
          const image = event.currentTarget;
          // Shown decoded, so the thumbnail never gives way to an empty frame.
          const show = () => setImageFit(fit(image));
          image.decode().then(show, show);
        }}
        onError={onError}
        className={cn("absolute inset-0 size-full", imageFit ?? "invisible")}
      />
    </div>
  );
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
    <>
      {viewer === "native" ? (
        <iframe
          title={`Preview of ${name}`}
          src={url}
          className="min-h-0 w-full flex-1 rounded-md border bg-muted"
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
        className="shrink-0 self-start font-medium text-primary underline-offset-4 hover:underline"
      >
        Open in a new tab
      </a>
    </>
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
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-md bg-muted p-6">
        <p role="alert" className="max-w-sm text-pretty text-center text-sm">
          {content.error.message}
        </p>
      </div>
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
    <>
      <div className={PreviewShape.frame} data-preview-scroll>
        {view}
      </div>
      <div className={PreviewShape.actions}>
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
              size="compact"
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
              variant="tertiary"
              size="compact"
              onClick={() => setMode({ type: "edit", base: editBase })}
            >
              Edit
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
