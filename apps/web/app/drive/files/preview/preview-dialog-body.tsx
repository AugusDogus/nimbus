import { ChevronLeft } from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";
import { toast } from "@/lib/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/alert-dialog";
import { hasThumbnail, thumbnailSrc } from "../entry-thumbnail";
import type { FileEntry } from "../types";
// In this chunk, not a lazy one of its own: the dialog's first frame then holds the preview's
// stage and poster, not a placeholder of another shape.
import FilePreview from "./file-preview";

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

export type PreviewDialogProps = {
  entry: FileEntry;
  /** Files in on-screen order, used for previous and next. */
  entries: readonly FileEntry[];
  onNavigate: (entry: FileEntry) => void;
  onClose: () => void;
};

export default function PreviewDialog({
  entry,
  entries,
  onNavigate,
  onClose,
}: PreviewDialogProps) {
  const url = `/api/files/download?path=${encodeURIComponent(entry.path)}`;
  const index = entries.findIndex((item) => item.path === entry.path);
  const previous = index > 0 ? entries[index - 1] : undefined;
  const next =
    index >= 0 && index < entries.length - 1 ? entries[index + 1] : undefined;
  const panel = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  // Closing with unsaved edits asks first: they can be minutes of typing. A press outside is
  // ignored instead, as a stray tap rather than a choice.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
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
      unsavedInput={dirty}
      onOpenChange={(open) => {
        if (open) return;
        if (dirty) setConfirmDiscard(true);
        else onClose();
      }}
    >
      <DialogContent
        ref={panel}
        // The panel, not the first control inside: a video's would keep the arrow keys that
        // step between files.
        initialFocus={panel}
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
            poster={hasThumbnail(entry) ? thumbnailSrc(entry) : undefined}
          />
        </div>
        <DialogFooter className="flex-row items-center justify-end gap-2">
          {entries.length > 1 && (
            <div className="mr-auto flex gap-1">
              <Button
                variant="tertiary"
                size="icon"
                aria-label="Previous file"
                disabled={!previous}
                onClick={() => go(previous)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="tertiary"
                size="icon"
                aria-label="Next file"
                disabled={!next}
                onClick={() => go(next)}
              >
                {/* A mirrored ChevronLeft: sharing ChevronRight with Settings
                    makes the bundler split a chunk off every Settings page. */}
                <ChevronLeft className="-scale-x-100" />
              </Button>
            </div>
          )}
          <Button render={<a href={url} download />}>Download</Button>
        </DialogFooter>
        <AlertDialog
          open={confirmDiscard}
          onOpenChange={(open) => {
            if (!open) setConfirmDiscard(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-balance">
                Discard your edits?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Your changes to {entry.name} have not been saved. The file
                itself is unchanged.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onClose}>
                Discard edits
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
