import { queryOptions } from "@tanstack/react-query";
import { IconChoice } from "./icon-choice";
import { trpcClient } from "./trpc";

/** The account's icon set. Kept apart from the icons themselves, which only file pages load. */
export const iconChoiceQuery = queryOptions<IconChoice>({
  queryKey: ["appearance", "icons"],
  queryFn: async () => {
    const choice = await trpcClient.appearance.icons.query();
    IconChoice.cache(choice);
    return choice;
  },
  // Another browser may change it; a focused page checks again after a few seconds.
  staleTime: 5_000,
});
