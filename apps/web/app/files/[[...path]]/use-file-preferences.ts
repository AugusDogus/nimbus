import { useMutation, useQuery } from "@tanstack/react-query";

import type { UserPreferences } from "@nimbus/api/context";

import { queryClient, trpcClient } from "@/lib/trpc";

const defaultPreferences: UserPreferences = {
  view: "list",
  sortField: "name",
  sortDirection: "asc",
  groupByType: true,
};

export const useFilePreferences = (enabled: boolean) => {
  const prefsQuery = useQuery<UserPreferences, Error>({
    queryKey: ["prefs"] as const,
    queryFn: () => trpcClient.prefs.get.query() as Promise<UserPreferences>,
    enabled,
  });

  const prefs = prefsQuery.data ?? defaultPreferences;

  const prefsMutation = useMutation({
    mutationFn: (next: UserPreferences) => trpcClient.prefs.set.mutate(next),
  });

  const updatePreferences = (partial: Partial<UserPreferences>) => {
    const next: UserPreferences = { ...prefs, ...partial };
    queryClient.setQueryData(["prefs"], next);
    prefsMutation.mutate(next);
  };

  return {
    prefs,
    updatePreferences,
  };
};
