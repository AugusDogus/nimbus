import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { count, eq } from "drizzle-orm";
import { db } from "../db";
import { importedIconTheme } from "../db/schema";
import { getConfigRoot } from "../storage-paths";
import { archiveLimits, IconThemeArchive } from "./icon-theme-archive";
import { IconThemeCompiler } from "./icon-theme-compiler";
import { IconThemeFiles } from "./icon-theme-files";
import { importedDirectory, type LibraryResult } from "./icon-theme-library";
import { OpenVsxClient } from "./open-vsx-client";

/**
 * Imports the file icon themes of an Open VSX extension for one account. The server downloads
 * the extension itself, checks it against the checksum Open VSX publishes, reads it under the
 * archive's caps, compiles each icon theme it contributes, and stores each under a directory
 * named by a fresh UUID. A theme that cannot be used (a font-based one, say) is skipped with
 * its reason; when none can, nothing is stored.
 */
export const maxImportedSets = 20;
const running = new Set<string>();
let swept = false;

/** Removes imported directories no account owns any more, and staging left by a crash. */
async function sweep() {
  if (swept) return;
  swept = true;
  const root = path.join(getConfigRoot(), "icon-themes", "imported");
  const names = await readdir(root).catch(() => []);
  const owned = new Set(
    (await db.select({ id: importedIconTheme.id }).from(importedIconTheme)).map(
      (row) => row.id,
    ),
  );
  for (const name of names)
    if (!owned.has(name)) await IconThemeFiles.remove(path.join(root, name));
}

export type ImportedSets = {
  added: { id: string; name: string }[];
  /** Themes the extension contributes that Nimbus could not use, with why. */
  skipped: string[];
};

async function run(
  userId: string,
  namespace: string,
  name: string,
): Promise<LibraryResult<ImportedSets>> {
  await sweep();
  const [existing] = await db
    .select({ total: count() })
    .from(importedIconTheme)
    .where(eq(importedIconTheme.userId, userId));
  const room = maxImportedSets - (existing?.total ?? 0);
  if (room <= 0)
    return {
      ok: false,
      error: `You have imported ${maxImportedSets} icon sets, the most Nimbus keeps per account. Remove one and try again.`,
    };
  const downloaded = await OpenVsxClient.download(namespace, name, {
    limit: archiveLimits.archiveBytes,
  });
  if (!downloaded.ok) return downloaded;
  const archive = IconThemeArchive.read(downloaded.value.bytes);
  if (!archive.ok)
    return { ok: false, error: `${archive.error} Nothing was installed.` };
  const listed = IconThemeCompiler.contributions(archive.files);
  if (!listed.ok) return listed;
  const extension = `${downloaded.value.namespace}.${downloaded.value.name}@${downloaded.value.version}`;
  const result: ImportedSets = { added: [], skipped: [] };
  for (const contribution of listed.value.themes) {
    if (result.added.length >= room) {
      result.skipped.push(
        `${contribution.label}: you reached ${maxImportedSets} imported sets.`,
      );
      continue;
    }
    const themePath = IconThemeCompiler.themePath(contribution);
    const compiled = themePath
      ? IconThemeCompiler.compile(archive.files, { dark: themePath })
      : {
          ok: false as const,
          error: "Its theme file points outside the extension.",
        };
    if (!compiled.ok) {
      result.skipped.push(`${contribution.label}: ${compiled.error}`);
      continue;
    }
    const id = randomUUID();
    const written = await IconThemeFiles.write(
      importedDirectory(id),
      compiled.value,
    );
    await db.insert(importedIconTheme).values({
      id,
      userId,
      name: contribution.label.slice(0, 200),
      extension,
      licence: listed.value.licence,
      bytes: written.bytes,
    });
    result.added.push({ id, name: contribution.label });
  }
  if (result.added.length === 0)
    return {
      ok: false,
      error: `${result.skipped.join(" ")} Nothing was installed.`,
    };
  return { ok: true, value: result };
}

/** One import at a time per account; each holds a download and its unpacked files in memory. */
async function importExtension(
  userId: string,
  namespace: string,
  name: string,
): Promise<LibraryResult<ImportedSets>> {
  if (running.has(userId) || running.size >= 2)
    return {
      ok: false,
      error:
        "Another icon set is still importing on this server. Wait for it to finish, then try again.",
    };
  running.add(userId);
  try {
    return await run(userId, namespace, name);
  } finally {
    running.delete(userId);
  }
}

export const IconThemeImport = { importExtension } as const;
