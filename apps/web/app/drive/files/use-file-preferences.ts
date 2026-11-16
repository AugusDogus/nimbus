import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";

import type { UserPreferences } from "@nimbus/api/context";

import { queryClient, trpcClient } from "@/lib/trpc";

const defaultPreferences: UserPreferences = {
  view: "list",
  sortField: "name",
  sortDirection: "asc",
  groupByType: true,
};

export const prefsQueryOptions = queryOptions<UserPreferences>({
  queryKey: ["prefs"],
  queryFn: () => trpcClient.prefs.get.query(),
});

/** Whether listings sorted by these preferences need sizes and modification times. */
export const needsStats = (prefs: UserPreferences) =>
  prefs.sortField === "modified" || prefs.sortField === "size";

export const useFilePreferences = (enabled: boolean) => {
  const prefsQuery = useQuery({ ...prefsQueryOptions, enabled });

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
