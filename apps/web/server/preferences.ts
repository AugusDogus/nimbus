import "server-only";

import { eq } from "drizzle-orm";

import { UserPreferences, type PreferencesStore } from "@nimbus/api/context";

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

    // Columns are plain text; only values the API accepted are ever written.
    return UserPreferences.parse({
      view: row.view,
      sortField: row.sortField,
      sortDirection: row.sortDirection,
      groupByType: row.groupByType,
    });
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
