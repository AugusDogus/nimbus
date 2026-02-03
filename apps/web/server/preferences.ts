import "server-only";

import { eq } from "drizzle-orm";

import type { PreferencesStore, UserPreferences } from "@nimbus/api/context";

import { db } from "./db";
import { userPreferences } from "./db/schema";

const defaultPreferences: UserPreferences = {
  view: "list",
  sortField: "name",
  sortDirection: "asc",
  groupByType: true,
};

export const preferencesStore: PreferencesStore = {
  async getUserPreferences(userId) {
    const rows = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      view: row.view as UserPreferences["view"],
      sortField: row.sortField as UserPreferences["sortField"],
      sortDirection: row.sortDirection as UserPreferences["sortDirection"],
      groupByType: row.groupByType,
    };
  },
  async setUserPreferences(userId, preferences) {
    await db
      .insert(userPreferences)
      .values({
        userId,
        view: preferences.view,
        sortField: preferences.sortField,
        sortDirection: preferences.sortDirection,
        groupByType: preferences.groupByType,
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          view: preferences.view,
          sortField: preferences.sortField,
          sortDirection: preferences.sortDirection,
          groupByType: preferences.groupByType,
          updatedAt: new Date(),
        },
      });

    return preferences;
  },
};

export const resolvePreferences = (
  stored: UserPreferences | null,
): UserPreferences => {
  return stored ?? defaultPreferences;
};
