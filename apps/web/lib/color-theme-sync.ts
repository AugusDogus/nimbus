import { TRPCClientError } from "@trpc/client";
import { ThemePreferences, themeOwnerStorageKey } from "./theme-preferences";
import { ThemeOutbox, type StagedChange } from "./theme-outbox";
import { ThemeStore } from "./theme-store";
import { trpcClient } from "./trpc";
import type { ThemeResult } from "./vscode-theme";

/**
 * Keeps this browser's copy of the account's color themes in step with the server's. The
 * browser copy (`localStorage`) exists so the boot script paints the right colors in the first
 * frame; the server's copy is the truth. Changes apply here at once and are confirmed or undone
 * by the server's answer.
 *
 * Pages stage a change with `ThemeOutbox.stage`, which applies and queues it at once, then send
 * it here. Leaving the page can cut a request off unanswered; the next load sends what the
 * outbox still holds before anything else, so a choice made just before navigating is not lost.
 *
 * On each load the browser then takes the server's copy, with one exception: a browser whose
 * copy predates syncing (it has no owner mark) brings its themes to the account once, merged as
 * `mergeColorThemes` on the server describes, then marks the copy as the account's.
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
  "Nimbus could not reach the server. The theme applies in this browser and is saved to your account the next time Nimbus loads with a connection.";

/** Sends a change `ThemeOutbox.stage` applied, and takes the server's answer. */
async function send(
  staged: StagedChange,
): Promise<ThemeResult<ThemePreferences>> {
  try {
    const saved = parse(
      await trpcClient.appearance.changeColorThemes.mutate(staged.change),
    );
    ThemeOutbox.settle(staged.id);
    const current = ThemeStore.current();
    if (saved) ThemeStore.replace(saved);
    return saved
      ? { ok: true, value: saved }
      : current.ok
        ? current
        : { ok: false, error: unreachable };
  } catch (error) {
    // No answer, as when the page is left mid-request: the change stays here and in the outbox.
    if (!(error instanceof TRPCClientError && error.data))
      return { ok: false, error: unreachable };
    ThemeOutbox.settle(staged.id);
    if (staged.previous) ThemeStore.replace(staged.previous);
    return { ok: false, error: error.message };
  }
}

let reconciled: string | null = null;

/** Takes the server's copy for `userId`, migrating a pre-sync copy first. Once per load. */
async function reconcile(userId: string) {
  if (reconciled === userId) return;
  reconciled = userId;
  // Changes a previous page sent without hearing back go first, in order. One the server
  // refuses is dropped: the server's copy then shows what it kept. When the server cannot be
  // reached they stay for the next load.
  if (owner() === userId)
    for (const pending of ThemeOutbox.pending()) {
      try {
        await trpcClient.appearance.changeColorThemes.mutate(pending.change);
      } catch (error) {
        if (!(error instanceof TRPCClientError && error.data)) throw error;
      }
      ThemeOutbox.settle(pending.id);
    }
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

export const ColorThemeSync = { send, reconcile } as const;
