import { TRPCClientError } from "@trpc/client";
import {
  ThemePreferences,
  themeOwnerStorageKey,
  type ThemeChange,
} from "./theme-preferences";
import { ThemeStore } from "./theme-store";
import { trpcClient } from "./trpc";
import type { ThemeResult } from "./vscode-theme";

/**
 * Keeps this browser's copy of the account's color themes in step with the server's. The
 * browser copy (`localStorage`) exists so the boot script paints the right colors in the first
 * frame; the server's copy is the truth. Changes apply here at once and are confirmed or undone
 * by the server's answer.
 *
 * On each load the browser takes the server's copy, with one exception: a browser whose copy
 * predates syncing (it has no owner mark) brings its themes to the account once, merged as
 * `ThemePreferences.merge` describes, then marks the copy as the account's.
 */
const parse = (value: unknown): ThemePreferences | null => {
  const result = ThemePreferences.schema.safeParse(value);
  return result.success ? result.data : null;
};

function owner(): string | null {
  try {
    return localStorage.getItem(themeOwnerStorageKey);
  } catch {
    return null;
  }
}

function adopt(value: ThemePreferences, userId: string | null) {
  ThemeStore.replace(value);
  if (userId === null) return;
  try {
    localStorage.setItem(themeOwnerStorageKey, userId);
  } catch {
    // Without storage the boot script has nothing to paint from; the app still applies it.
  }
}

const unreachable =
  "Nimbus could not save the theme change to the server. Check your connection and try again. Your previous themes are unchanged.";

async function change(
  update: ThemeChange,
): Promise<ThemeResult<ThemePreferences>> {
  const previous = ThemeStore.current();
  // An unreadable copy can still be reset: the server's answer replaces it.
  if (!previous.ok && update.kind !== "reset") return previous;
  const next = ThemePreferences.apply(
    previous.ok ? previous.value : ThemePreferences.empty,
    update,
  );
  if (!next.ok) return next;
  ThemeStore.replace(next.value);
  try {
    const saved = parse(
      await trpcClient.appearance.changeColorThemes.mutate(update),
    );
    if (saved) ThemeStore.replace(saved);
    return { ok: true, value: saved ?? next.value };
  } catch (error) {
    if (previous.ok) ThemeStore.replace(previous.value);
    return {
      ok: false,
      error: error instanceof TRPCClientError ? error.message : unreachable,
    };
  }
}

let reconciled: string | null = null;

/** Takes the server's copy for `userId`, migrating a pre-sync copy first. Once per load. */
async function reconcile(userId: string) {
  if (reconciled === userId) return;
  reconciled = userId;
  const server = parse(await trpcClient.appearance.colorThemes.query());
  const local = ThemeStore.current();
  const legacy =
    owner() === null &&
    local.ok &&
    (local.value.themes.length > 0 ||
      local.value.light !== null ||
      local.value.dark !== null);
  if (legacy && local.ok) {
    const merged = parse(
      await trpcClient.appearance.migrateColorThemes.mutate(local.value),
    );
    if (merged) adopt(merged, userId);
    return;
  }
  adopt(server ?? ThemePreferences.empty, userId);
}

export const ColorThemeSync = { change, reconcile } as const;
