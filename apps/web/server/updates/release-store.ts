import { constants } from "node:fs";
import { open, readdir, readlink, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ReleaseManifest } from "./release-manifest";
import { ReleaseSignature, type TrustRoot } from "./release-signature";
import { ReleaseTree } from "./release-tree";
import { UpdateSchedule } from "./update-schedule";

/**
 * The installed releases (see docs/updates.md): `<releases>/<name>/` for each, holding the
 * signed manifest it was installed from (`release-manifest.json`, `release-manifest.sig`), and
 * `<releases>/state.json` with what runs and what ran. Only the supervisor's user writes here.
 */
export type ReleaseState = {
  /** The release servers start from; null for the image's built-in one. */
  current: string | null;
  /**
   * The release that ran before `current`, which a rollback returns to: an installed release's
   * name, or "built-in" for the image's own; null when nothing ran before.
   */
  previous: string | null;
  /**
   * The release a handover is switching to until it is active. A full restart stops every
   * server first and may apply migrations the earlier release cannot run on, so this is what
   * starts at boot if the container stops before it took over.
   */
  pending: string | null;
  /**
   * The highest build sequence any release ran here, by repository and channel (see
   * ReleaseIdentity and `watermarkKey`): no check offers one at or below it.
   */
  watermarks: Record<string, number>;
  /** When the update source was last asked, and what it answered. */
  lastCheck: { at: string; outcome: string } | null;
  /** When updates are looked for and installed on their own (UpdateSchedule). */
  schedule: UpdateSchedule;
  /** The day an automatic install was last tried (UpdateSchedule.day), at most once a day. */
  lastAutomatic: string | null;
};

const stateSchema = z.object({
  current: z.string().nullable(),
  previous: z.string().nullable(),
  pending: z.string().nullable(),
  watermarks: z.record(z.string(), z.number().int().nonnegative()),
  lastCheck: z.object({ at: z.string(), outcome: z.string() }).nullable(),
  // Absent from states written before schedules existed.
  schedule: UpdateSchedule.schema.default(UpdateSchedule.standard),
  lastAutomatic: z.string().nullable().default(null),
});

/** A regular file's bytes, never read through a link or from a pipe or device. */
async function readPlain(file: string): Promise<Uint8Array<ArrayBuffer>> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw Object.assign(new Error(`${file} is not a regular file`), {
        code: "EFTYPE",
      });
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

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
    pending: null,
    watermarks: {},
    lastCheck: null,
    schedule: UpdateSchedule.standard,
    lastAutomatic: null,
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
      text = new TextDecoder().decode(
        await readPlain(path.join(releases, STATE_FILE)),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { ok: true, value: fallback };
      // Unreadable is as unknown as damaged: the same refusal, never a stopped startup.
      return {
        ok: false,
        message: `${path.join(releases, STATE_FILE)} could not be read (${error instanceof Error && "code" in error ? String(error.code) : "unknown error"}), so Nimbus does not know which release ran last. It starts the image's built-in release; check the file's owner and permissions, or remove it to start afresh, which forgets which releases ran here.`,
      };
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
      manifest = await readPlain(path.join(root, MANIFEST_FILE));
      signature = await readPlain(path.join(root, SIGNATURE_FILE));
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
    /** Who must own every entry: root, or the store's owner when everything is one user. */
    owner: number,
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
    let tree: { sha256: string; entries: number };
    try {
      tree = await ReleaseTree.digest(
        root,
        new Set([MANIFEST_FILE, SIGNATURE_FILE, ...linked]),
        { owner },
      );
    } catch (error) {
      return {
        ok: false,
        message: `Release ${name} cannot be trusted to stay as it was signed (${error instanceof Error ? error.message : String(error)}), so it was not started.`,
      };
    }
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
  async prune(releases: string, keep: ReadonlySet<string>, trust: TrustRoot) {
    const removed: string[] = [];
    let entries: string[] = [];
    try {
      entries = await readdir(releases);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return removed;
      throw error;
    }
    // Only the attempt folders the installer makes (`.install-<release>-` and mkdtemp's six).
    for (const entry of entries)
      if (
        /^\.install-[a-z][a-z0-9-]{0,31}-\d+-[0-9a-f]{12}-[\w]{6}$/.test(entry)
      ) {
        await rm(path.join(releases, entry), { recursive: true, force: true });
        removed.push(entry);
      }
    // Only what this store installed: a release whose signed manifest verifies under its name.
    const installed: string[] = [];
    for (const name of await ReleaseStore.installed(releases))
      if (
        /^[a-z][a-z0-9-]{0,31}-\d+-[0-9a-f]{12}$/.test(name) &&
        (await ReleaseStore.verified(releases, name, trust)).ok
      )
        installed.push(name);
    for (const name of installed.slice(KEEP))
      if (!keep.has(name)) {
        await rm(path.join(releases, name), { recursive: true, force: true });
        removed.push(name);
      }
    return removed;
  },
} as const;
