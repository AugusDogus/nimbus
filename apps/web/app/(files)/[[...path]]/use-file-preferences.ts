import { useMutation, useQuery } from "@tanstack/react-query";

import type { UserPreferences } from "@nimbus/api/context";

import { queryClient, trpcClient } from "@/lib/trpc";

const defaultPreferences: UserPreferences = {
  view: "list",
  sortField: "name",
  sortDirection: "asc",
  groupByType: true,
};

const VIEW_COOKIE_NAME = "nimbus_view";
const VIEW_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const setViewCookie = (view: UserPreferences["view"]) => {
  document.cookie = `${VIEW_COOKIE_NAME}=${view}; path=/; max-age=${VIEW_COOKIE_MAX_AGE}`;
};

export const useFilePreferences = (
  enabled: boolean,
  initialData?: UserPreferences,
) => {
  const prefsQuery = useQuery<UserPreferences, Error>({
    queryKey: ["prefs"] as const,
    queryFn: () => trpcClient.prefs.get.query() as Promise<UserPreferences>,
    enabled,
    initialData,
  });

  const prefs = prefsQuery.data ?? defaultPreferences;

  const prefsMutation = useMutation({
    mutationFn: (next: UserPreferences) => trpcClient.prefs.set.mutate(next),
  });

  const updatePreferences = (partial: Partial<UserPreferences>) => {
    const next: UserPreferences = { ...prefs, ...partial };
    queryClient.setQueryData(["prefs"], next);
    prefsMutation.mutate(next);
    if (partial.view) {
      setViewCookie(partial.view);
    }
  };

  return {
    prefs,
    updatePreferences,
  };
};
