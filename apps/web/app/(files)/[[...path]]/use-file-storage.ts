import { useQuery } from "@tanstack/react-query";

import { trpcClient } from "@/lib/trpc";

export type StorageSummary =
  | { status: "loading" | "unavailable" }
  | {
      status: "ready";
      usedLabel: string;
      capacity: {
        usedPercent: number;
        availableLabel: string;
        totalLabel: string;
      } | null;
    };

const formatBytes = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
};

export const useFileStorage = (enabled: boolean): StorageSummary => {
  const storageQuery = useQuery({
    queryKey: ["files.storage"] as const,
    queryFn: () => trpcClient.files.storage.query(),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (!enabled) return { status: "unavailable" };
  if (storageQuery.isPending) return { status: "loading" };
  if (!storageQuery.data) return { status: "unavailable" };

  const { usedBytes, capacity } = storageQuery.data;
  return {
    status: "ready",
    usedLabel: formatBytes(usedBytes),
    capacity: capacity
      ? {
          usedPercent: Math.round(
            (1 - capacity.availableBytes / capacity.totalBytes) * 100,
          ),
          availableLabel: formatBytes(capacity.availableBytes),
          totalLabel: formatBytes(capacity.totalBytes),
        }
      : null,
  };
};
