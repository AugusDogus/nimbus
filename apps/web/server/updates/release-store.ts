import {
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ReleaseManifest } from "./release-manifest";
import { ReleaseSignature, type TrustRoot } from "./release-signature";
import { ReleaseTree } from "./release-tree";

/**
 * The installed releases (see docs/updates.md): `<releases>/<name>/` for each, holding the
 * signed manifest it was installed from (`release-manifest.json`, `release-manifest.sig`), and
 * `<releases>/state.json` with what runs and what ran. Only the supervisor's user writes here.
 */
export type ReleaseState = {
  /** The release servers start from; null for the image's built-in one. */
  current: string | null;
  /** The release that ran before `current`, which a rollback returns to; null for built-in. */
  previous: string | null;
  /**
   * The highest build sequence any release ran here, by repository and channel (see
   * ReleaseIdentity and `watermarkKey`): no check offers one at or below it.
   */
  watermarks: Record<string, number>;
  /** When the update source was last asked, and what it answered. */
  lastCheck: { at: string; outcome: string } | null;
};

const stateSchema = z.object({
  current: z.string().nullable(),
  previous: z.string().nullable(),
  watermarks: z.record(z.string(), z.number().int().nonnegative()),
  lastCheck: z.object({ at: z.string(), outcome: z.string() }).nullable(),
});

export const MANIFEST_FILE = "release-manifest.json";
export const SIGNATURE_FILE = "release-manifest.sig";
const STATE_FILE = "state.json";
let writes = 0;
/** Installed releases kept beyond the current and the previous one. */
const KEEP = 3;

export const ReleaseStore = {
  empty: (): ReleaseState => ({
    current: null,
    previous: null,
    watermarks: {},
    lastCheck: null,
  }),

  /** The key of `identity`'s watermark. */
  watermarkKey: (identity: { repository: string; channel: string }) =>
    `${identity.repository} ${identity.channel}`,

  /** The state, or `fallback` when none was written yet. A damaged state file is an error. */
  async read(
    releases: string,
    fallback: ReleaseState,
  ): Promise<
    { ok: true; value: ReleaseState } | { ok: false; message: string }
  > {
    let text: string;
    try {
      text = await readFile(path.join(releases, STATE_FILE), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { ok: true, value: fallback };
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    const parsed = stateSchema.safeParse(value);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : {
          ok: false,
          message: `${path.join(releases, STATE_FILE)} is damaged, so Nimbus does not know which release ran last. It starts the image's built-in release; remove the file to start afresh, which forgets which releases ran here.`,
        };
  },

  /**
   * Write the state whole and durably: a crash or power loss leaves the old state or the new
   * one. Each write has a temporary file of its own; the caller keeps writes in order.
   */
  async write(releases: string, state: ReleaseState) {
    const file = path.join(releases, STATE_FILE);
    const temporary = `${file}.${process.pid}.${++writes}.tmp`;
    const handle = await open(temporary, "wx", 0o644);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    const folder = await open(releases, "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  },

  /**
   * Installed release `name`, verified again against the image's trust root: its signed
   * manifest, and that it was installed under the name the manifest gives it.
   */
  async verified(releases: string, name: string, trust: TrustRoot) {
    const root = path.join(releases, name);
    let manifest: Uint8Array<ArrayBuffer>;
    let signature: Uint8Array<ArrayBuffer>;
    try {
      manifest = new Uint8Array(await readFile(path.join(root, MANIFEST_FILE)));
      signature = new Uint8Array(
        await readFile(path.join(root, SIGNATURE_FILE)),
      );
    } catch (error) {
      return {
        ok: false as const,
        message: `Release ${name} has no signed manifest (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
    const signed = await ReleaseSignature.verify(trust, manifest, signature);
    if (!signed.ok)
      return { ok: false as const, message: signed.error.message };
    const parsed = ReleaseManifest.parse(manifest);
    if (!parsed.ok)
      return { ok: false as const, message: parsed.error.message };
    if (ReleaseManifest.releaseName(parsed.value) !== name)
      return {
        ok: false as const,
        message: `Release ${name} holds the manifest of ${ReleaseManifest.releaseName(parsed.value)}.`,
      };
    return { ok: true as const, manifest: parsed.value, root };
  },

  /**
   * Whether installed release `root` is the tree `manifest` signed: its digest, leaving out the
   * installer's own files and the native packages it linked, each of which must lead to the
   * image's copy (`natives`, by name).
   */
  async intact(
    root: string,
    manifest: ReleaseManifest,
    natives: ReadonlyMap<string, string>,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const name = ReleaseManifest.releaseName(manifest);
    const linked = Object.keys(manifest.requires.native).map(
      (native) => `apps/web/node_modules/${native}`,
    );
    for (const native of Object.keys(manifest.requires.native)) {
      const target = await readlink(
        path.join(root, "apps/web/node_modules", native),
      ).catch(() => null);
      if (target === null || target !== natives.get(native))
        return {
          ok: false,
          message: `Release ${name} does not link ${native} to this image's copy, so it was not started.`,
        };
    }
    const tree = await ReleaseTree.digest(
      root,
      new Set([MANIFEST_FILE, SIGNATURE_FILE, ...linked]),
    ).catch((error: unknown) => ({
      sha256: `unreadable (${error instanceof Error ? error.message : String(error)})`,
      entries: 0,
    }));
    if (
      tree.sha256 !== manifest.tree.sha256 ||
      tree.entries !== manifest.tree.entries
    )
      return {
        ok: false,
        message: `Release ${name} is not the tree its signed manifest describes (${tree.entries} entries, digest ${tree.sha256}, where ${manifest.tree.entries} and ${manifest.tree.sha256} were signed): a file in it was changed, removed or added, so it was not started.`,
      };
    return { ok: true };
  },

  /** Installed release names, newest build first. Staging leftovers are not releases. */
  async installed(releases: string) {
    let names: string[];
    try {
      names = (await readdir(releases, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
    const sequence = (name: string) =>
      Number(/-(\d+)-[0-9a-f]{12}$/.exec(name)?.[1] ?? 0);
    return names.sort((a, b) => sequence(b) - sequence(a));
  },

  /**
   * Remove what is not needed: staging leftovers, and installed releases beyond the newest few,
   * except those in `keep` (the current and previous release, any a server still runs).
   */
  async prune(releases: string, keep: ReadonlySet<string>) {
    const removed: string[] = [];
    let entries: string[] = [];
    try {
      entries = await readdir(releases);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return removed;
      throw error;
    }
    for (const entry of entries)
      if (
        entry.startsWith(".install-") ||
        entry.startsWith(".staging-") ||
        entry.startsWith(".download-")
      ) {
        await rm(path.join(releases, entry), { recursive: true, force: true });
        removed.push(entry);
      }
    const installed = await ReleaseStore.installed(releases);
    for (const name of installed.slice(KEEP))
      if (!keep.has(name)) {
        await rm(path.join(releases, name), { recursive: true, force: true });
        removed.push(name);
      }
    return removed;
  },
} as const;
