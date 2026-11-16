import { Progress } from "@/components/ui/progress";
import type { StorageSummary } from "./use-file-storage";

export function StorageIndicator({ storage }: { storage: StorageSummary }) {
  const capacity = storage.status === "ready" ? storage.capacity : null;

  return (
    <section
      aria-label="Storage usage"
      className="overflow-hidden rounded-xl bg-sidebar-accent/50 group-data-[collapsible=icon]:hidden"
    >
      <div className="space-y-3 rounded-xl bg-background/80 p-3">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="font-medium text-foreground">
            {capacity ? "Disk storage" : "Storage"}
          </span>
          {capacity && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {capacity.usedPercent}% used
            </span>
          )}
        </div>
        {capacity ? (
          <>
            <Progress
              aria-label="Disk storage used"
              value={capacity.usedPercent}
              className="*:data-[slot=progress-track]:h-1.5 *:data-[slot=progress-track]:bg-foreground/10 [&_[data-slot=progress-indicator]]:bg-foreground/80"
            />
            <p className="text-xs tabular-nums text-muted-foreground">
              {capacity.availableLabel} free of {capacity.totalLabel}
            </p>
          </>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            {storage.status === "loading"
              ? "Calculating storage…"
              : storage.status === "ready"
                ? "Disk capacity unavailable"
                : "Storage unavailable. Try again shortly."}
          </p>
        )}
      </div>
      {storage.status === "ready" && (
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 text-xs text-muted-foreground">
          <span>Nimbus files</span>
          <span className="tabular-nums">{storage.usedLabel}</span>
        </div>
      )}
    </section>
  );
}
