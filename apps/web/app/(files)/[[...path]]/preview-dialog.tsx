"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { lazy, Suspense, useRef, useState, type PointerEvent } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { FilePreviewProps } from "./preview/file-preview";
import type { FileEntry } from "./types";

// Every renderer loads on first preview, so browsing never pays for them.
const FilePreviewBody = lazy(() => import("./preview/file-preview"));

export type { FilePreviewProps };

export function FilePreview(props: FilePreviewProps) {
  return (
    <Suspense
      fallback={
        <Skeleton
          aria-label="Loading preview"
          className="h-[min(65dvh,32rem)] w-full"
        />
      }
    >
      <FilePreviewBody {...props} />
    </Suspense>
  );
}

const formatSize = (bytes: number) =>
  new Intl.NumberFormat(undefined, {
    notation: "compact",
    style: "unit",
    unit: "byte",
    unitDisplay: "narrow",
  }).format(bytes);

/** Keys from editable or media controls stay with those controls. */
const ownsArrowKeys = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest("input, textarea, select, video, audio, [role=slider]") !==
      null);

export function PreviewDialog({
  entry,
  entries,
  onNavigate,
  onClose,
}: {
  entry: FileEntry;
  /** Files in on-screen order, used for previous and next. */
  entries: readonly FileEntry[];
  onNavigate: (entry: FileEntry) => void;
  onClose: () => void;
}) {
  const url = `/api/files/download?path=${encodeURIComponent(entry.path)}`;
  const index = entries.findIndex((item) => item.path === entry.path);
  const previous = index > 0 ? entries[index - 1] : undefined;
  const next =
    index >= 0 && index < entries.length - 1 ? entries[index + 1] : undefined;
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const guard = () => {
    if (dirty) toast("Save or cancel your edits first.");
    return dirty;
  };
  const go = (target: FileEntry | undefined) => {
    if (target && !guard()) onNavigate(target);
  };
  const details = [
    index >= 0 && entries.length > 1
      ? `${index + 1} of ${entries.length}`
      : null,
    entry.size !== null ? formatSize(entry.size) : null,
  ].filter(Boolean);
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    swipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) / 2) return;
    go(dx < 0 ? next : previous);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !guard()) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-5xl"
        onKeyDown={(event) => {
          if (event.defaultPrevented || ownsArrowKeys(event.target)) return;
          const target =
            event.key === "ArrowLeft"
              ? previous
              : event.key === "ArrowRight"
                ? next
                : undefined;
          if (!target) return;
          event.preventDefault();
          go(target);
        }}
      >
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="truncate text-balance leading-tight">
            {entry.name}
          </DialogTitle>
          <DialogDescription className="tabular-nums">
            {details.length ? details.join(" · ") : "File preview"}
          </DialogDescription>
        </DialogHeader>
        <div
          className="min-w-0 touch-pan-y"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (swipe.current = null)}
        >
          <FilePreview
            key={entry.path}
            name={entry.name}
            url={`${url}&preview=1`}
            editPath={entry.permission === "read" ? undefined : entry.path}
            onDirtyChange={setDirty}
          />
        </div>
        <DialogFooter className="flex-row items-center justify-end gap-2">
          {entries.length > 1 && (
            <div className="mr-auto flex gap-1">
              <Button
                variant="outline"
                size="icon"
                aria-label="Previous file"
                disabled={!previous}
                onClick={() => go(previous)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Next file"
                disabled={!next}
                onClick={() => go(next)}
              >
                <ChevronRight />
              </Button>
            </div>
          )}
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
