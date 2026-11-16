import { ChevronDown, RotateCw, X } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { UploadItem, UploadSnapshot } from "@/lib/upload-queue";
import { cn } from "@/lib/utils";
import { useUploads } from "./upload-provider";

const serverSnapshot: UploadSnapshot = {
  items: [],
  summary: {
    total: 0,
    queued: 0,
    active: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    sentBytes: 0,
    totalBytes: 0,
  },
};
/** Rows rendered in the details list. Large batches summarize the rest. */
const detailLimit = 200;

const percent = (sent: number, total: number) =>
  total === 0 ? 100 : Math.floor((sent / total) * 100);
const plural = (count: number, noun: string) =>
  `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
const displayPath = ({ request }: UploadItem) =>
  [request.folder, request.filename].filter(Boolean).join("/");

function statusText(item: UploadItem) {
  switch (item.status.kind) {
    case "queued":
      return "Waiting";
    case "uploading":
      return `${percent(item.status.sent, item.request.file.size)}%`;
    case "done":
      return "Uploaded";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return item.status.message;
  }
}

function UploadRow({
  item,
  onCancel,
  onRetry,
}: {
  item: UploadItem;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const name = displayPath(item);
  const running =
    item.status.kind === "queued" || item.status.kind === "uploading";
  return (
    <li className="flex items-center gap-3 py-2">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="truncate">{name}</span>
          <span
            className={cn(
              "shrink-0 text-xs tabular-nums text-muted-foreground",
              item.status.kind === "failed" &&
                "max-w-[50%] truncate text-destructive",
            )}
            title={
              item.status.kind === "failed" ? item.status.message : undefined
            }
          >
            {statusText(item)}
          </span>
        </div>
        {item.status.kind === "uploading" && (
          <Progress
            aria-label={`Upload progress for ${name}`}
            className="*:data-[slot=progress-track]:h-1"
            value={percent(item.status.sent, item.request.file.size)}
          />
        )}
      </div>
      {running ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Cancel upload of ${name}`}
          onClick={onCancel}
        >
          <X className="size-4" />
        </Button>
      ) : item.status.kind === "failed" || item.status.kind === "cancelled" ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Retry upload of ${name}`}
          onClick={onRetry}
        >
          <RotateCw className="size-4" />
        </Button>
      ) : null}
    </li>
  );
}

export function UploadProgress() {
  const { queue } = useUploads();
  const { items, summary } = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    () => serverSnapshot,
  );
  const [expanded, setExpanded] = useState(false);
  if (summary.total === 0) return null;
  const busy = summary.active + summary.queued > 0;
  const finished = summary.done + summary.failed + summary.cancelled;
  // Problems first, then what is moving, then what waits.
  const rank = {
    failed: 0,
    uploading: 1,
    queued: 2,
    cancelled: 3,
    done: 4,
  } as const;
  const shown = expanded
    ? [...items]
        .sort((a, b) => rank[a.status.kind] - rank[b.status.kind])
        .slice(0, detailLimit)
    : [];
  return (
    <div className="border-b px-4 py-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <p role="status" className="min-w-0 truncate">
          {busy
            ? `Uploading ${plural(summary.total, "file")}, ${finished.toLocaleString()} finished`
            : `${plural(summary.failed, "upload")} failed${summary.done ? `, ${plural(summary.done, "file")} uploaded` : ""}`}
          {summary.failed > 0 &&
            busy &&
            `, ${summary.failed.toLocaleString()} failed`}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {busy && (
            <span aria-hidden className="tabular-nums text-muted-foreground">
              {percent(summary.sentBytes, summary.totalBytes)}%
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            Details
            <ChevronDown
              className={cn(
                "size-4 transition-transform duration-150",
                expanded && "rotate-180",
              )}
            />
          </Button>
          {summary.failed > 0 && (
            <Button size="sm" variant="outline" onClick={queue.retryFailed}>
              Retry failed
            </Button>
          )}
          {busy ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void queue.cancelAll()}
            >
              Cancel upload
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={queue.clearFinished}>
              Dismiss
            </Button>
          )}
        </div>
      </div>
      {busy && (
        <Progress
          aria-label="Upload progress"
          className="mt-2"
          value={percent(summary.sentBytes, summary.totalBytes)}
        />
      )}
      {expanded && (
        <ul
          aria-label="Uploads"
          className="mt-2 max-h-64 divide-y overflow-y-auto overscroll-contain"
        >
          {shown.map((item) => (
            <UploadRow
              key={item.id}
              item={item}
              onCancel={() => void queue.cancel(item.id)}
              onRetry={() => queue.retry(item.id)}
            />
          ))}
          {items.length > shown.length && (
            <li className="py-2 text-sm text-muted-foreground">
              And {(items.length - shown.length).toLocaleString()} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
