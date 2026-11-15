"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileKind } from "@/lib/file-kind";
import { saveText } from "./save-text";
import { TEXT_LIMIT, TextContent } from "./text-content";

const MarkdownView = lazy(() => import("./markdown-view"));
const CodeView = lazy(() => import("./code-view"));
const TableView = lazy(() => import("./table-view"));
const TextEditor = lazy(() => import("./text-editor"));

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
          {/* eslint-disable-next-line @next/next/no-img-element */}
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
      return (
        <div className="space-y-2">
          <iframe
            title={`Preview of ${name}`}
            src={url}
            className="h-[65dvh] w-full rounded-md border bg-muted"
          />
          <Button asChild variant="link" className="h-auto p-0">
            <a href={url} target="_blank" rel="noopener">
              Open in a new tab
            </a>
          </Button>
        </div>
      );
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
  const content = useQuery({
    queryKey,
    queryFn: ({ signal }) => TextContent.load(url, signal),
    staleTime: 0,
    gcTime: 0,
  });
  const [mode, setMode] = useState<"view" | "source" | "edit">("view");
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
  const editable =
    editPath !== undefined && !data.truncated && data.etag !== null;
  if (mode === "edit" && editable && data.etag !== null) {
    const etag = data.etag;
    return (
      <Suspense fallback={loading}>
        <TextEditor
          initial={data.text}
          language={kind.type === "code" ? kind.language : undefined}
          onDirtyChange={onDirtyChange}
          onCancel={() => {
            onDirtyChange?.(false);
            setMode("view");
          }}
          onSave={async (text) => {
            const outcome = await saveText(editPath, etag, text);
            if (outcome.type === "saved") {
              queryClient.setQueryData(queryKey, {
                ...data,
                text,
                size: outcome.size,
                etag: outcome.etag,
              });
              onDirtyChange?.(false);
              setMode("view");
            }
            return outcome;
          }}
        />
      </Suspense>
    );
  }
  const view =
    kind.type === "markdown" && mode === "view" ? (
      <MarkdownView text={data.text} />
    ) : kind.type === "table" && mode === "view" ? (
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
        <Suspense fallback={loading}>{view}</Suspense>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {data.truncated && (
          <p className="text-pretty">
            Showing the first {TEXT_LIMIT / 1024 / 1024} MB. Download the file
            to see all of it.
          </p>
        )}
        <div className="ml-auto flex gap-2">
          {hasRendered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMode(mode === "source" ? "view" : "source")}
            >
              {mode === "source" ? "Show formatted" : "Show source"}
            </Button>
          )}
          {editable && (
            <Button variant="outline" size="sm" onClick={() => setMode("edit")}>
              Edit
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
