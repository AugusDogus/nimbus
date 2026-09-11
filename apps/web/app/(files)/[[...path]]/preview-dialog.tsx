"use client";

import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { FileEntry } from "./types";

export function FilePreview({ name, url }: { name: string; url: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const isText = ["txt", "md", "csv", "json", "log"].includes(ext);
  const text = useQuery({
    queryKey: ["preview", url],
    enabled: isText,
    queryFn: async () => {
      const response = await fetch(url, {
        headers: { Range: "bytes=0-262143" },
      });
      if (
        response.status === 416 &&
        response.headers.get("content-range") === "bytes */0"
      )
        return "";
      if (!response.ok)
        throw new Error(
          "Preview could not be loaded. Try downloading the file.",
        );
      return response.text();
    },
  });
  if (isText)
    return (
      <div className="max-h-[65dvh] overflow-auto rounded-md border bg-muted p-4">
        {text.isError ? (
          <p role="alert">{text.error.message}</p>
        ) : text.isPending ? (
          <p>Loading preview…</p>
        ) : (
          <>
            <pre className="whitespace-pre-wrap break-words text-sm">
              {text.data}
            </pre>
            <p className="mt-4 text-xs text-muted-foreground">
              Preview limited to the first 256 KB.
            </p>
          </>
        )}
      </div>
    );
  // Native media elements preserve browser zoom, playback, and accessibility controls.
  if (["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(ext))
    return (
      <div className="flex justify-center rounded-md bg-muted">
        <Image
          src={url}
          alt={name}
          unoptimized
          width={1024}
          height={768}
          className="max-h-[65dvh] max-w-full object-contain"
        />
      </div>
    );
  if (["mp4", "webm"].includes(ext))
    return (
      <video
        controls
        preload="metadata"
        src={url}
        className="max-h-[65dvh] w-full"
      >
        <track kind="captions" />
      </video>
    );
  if (["mp3", "wav", "ogg"].includes(ext))
    return <audio controls preload="metadata" src={url} className="w-full" />;
  if (ext === "pdf")
    return (
      <iframe
        title={`Preview of ${name}`}
        src={url}
        className="h-[65dvh] w-full rounded-md border"
      />
    );
  return (
    <p className="text-pretty text-sm text-muted-foreground">
      A preview is not available for this file type. Download it to open it on
      your device.
    </p>
  );
}

export function PreviewDialog({
  entry,
  onClose,
}: {
  entry: FileEntry;
  onClose: () => void;
}) {
  const url = `/api/files/download?path=${encodeURIComponent(entry.path)}`;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate text-balance">
            {entry.name}
          </DialogTitle>
          <DialogDescription>File preview</DialogDescription>
        </DialogHeader>
        <FilePreview name={entry.name} url={`${url}&preview=1`} />
        <DialogFooter className="flex-row justify-end">
          <Button asChild>
            <a href={url} download>
              Download
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
