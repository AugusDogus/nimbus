import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { trpcClient } from "@/lib/trpc";

type StorageSummary = {
  usedBytes: number | null;
  label: string;
  progressValue: number;
  isLoading: boolean;
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
  const storageQuery = useQuery<{ usedBytes: number }, Error>({
    queryKey: ["files.storage"] as const,
    queryFn: () => trpcClient.files.storage.query(),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const summary = useMemo<StorageSummary>(() => {
    if (!enabled) {
      return {
        usedBytes: null,
        label: "Sign in to see usage",
        progressValue: 0,
        isLoading: false,
      };
    }

    if (storageQuery.isLoading) {
      return {
        usedBytes: null,
        label: "Calculating usage…",
        progressValue: 0,
        isLoading: true,
      };
    }

    if (!storageQuery.data) {
      return {
        usedBytes: null,
        label: "Usage unavailable",
        progressValue: 0,
        isLoading: false,
      };
    }

    const used = storageQuery.data.usedBytes;
    return {
      usedBytes: used,
      label: `${formatBytes(used)} used (no limit)`,
      progressValue: 100,
      isLoading: false,
    };
  }, [enabled, storageQuery.data, storageQuery.isLoading]);

  return summary;
};
