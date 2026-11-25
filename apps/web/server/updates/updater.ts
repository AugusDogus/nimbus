import { mkdir } from "node:fs/promises";
import { ReleaseManifest, MAX_MANIFEST_BYTES } from "./release-manifest";
import { ReleaseSignature, type TrustRoot } from "./release-signature";
import { ReleaseStore, type ReleaseState } from "./release-store";
import { ImageAbi } from "./image-abi";
import type { BuildInfo } from "./build-info";
import { UpdateOffer, type ReleaseIdentity } from "./update-offer";
import { UpdateSource } from "./update-source";
import type { UpdateSchedule } from "./update-schedule";

/**
 * The supervisor's side of updates (see docs/updates.md): which release to start, checking the
 * update source, installing what it offers through the installer process, and keeping the state
 * of what ran. It never runs release code itself; the supervisor hands over to what it installs.
 */
export type UpdateStatus = {
  /** The release servers run now: an installed one by name, or the image's built-in one. */
  running: { name: string; sequence: number | null; commit: string | null };
  channel: string | null;
  source:
    | { kind: "off"; reason: string }
    | { kind: "url"; url: string; origin: string };
  /** Why nothing can install or roll back now, such as an image that trusts no key. */
  unavailable: string | null;
  lastCheck: ReleaseState["lastCheck"];
  /** What the last check found, if anything newer. */
  available: {
    kind: "offer" | "needs-newer-image";
    build: ReleaseManifest["build"];
    notes: ReleaseManifest["notes"];
    message: string;
  } | null;
  /** The release a rollback returns to, if any. */
  previous: string | null;
  /** When updates are looked for and installed on their own. */
  schedule: UpdateSchedule;
};

export type InstallRequest = {
  releases: string;
  source: string;
  manifest: string;
  signature: string;
};
/** Runs the installer process (supervisor/installer.ts) for `request`. */
export type RunInstaller = (
  request: InstallRequest,
) => Promise<{ ok: true; name: string } | { ok: false; message: string }>;

type Offered = {
  manifest: ReleaseManifest;
  bytes: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
};

type Done = { ok: true } | { ok: false; message: string };

const MAX_SIGNATURE_BYTES = 4096;
/**
 * The image's own release in the state's `previous`: never an installed release's name, which
 * always ends in a build number and a commit.
 */
export const BUILT_IN = "built-in";
const CHECK_TIMEOUT_MS = 30_000;

/** Fetch the source's `manifest.json` and `manifest.sig`, each within its size. */
export type FetchManifest = (
  source: Extract<UpdateSource, { kind: "url" }>,
) => Promise<
  | {
      ok: true;
      manifest: Uint8Array<ArrayBuffer>;
      signature: Uint8Array<ArrayBuffer>;
    }
  | { ok: false; message: string }
>;

/** Fetching in this process, as the installer does (see installer.ts). */
export const fetchManifestHere: FetchManifest = async (source) => {
  const manifest = await UpdateSource.fetchBytes(
    UpdateSource.url(source, "manifest.json"),
    { maxBytes: MAX_MANIFEST_BYTES, timeoutMs: CHECK_TIMEOUT_MS },
  );
  if (!manifest.ok) return { ok: false, message: manifest.error.message };
  const signature = await UpdateSource.fetchBytes(
    UpdateSource.url(source, "manifest.sig"),
    { maxBytes: MAX_SIGNATURE_BYTES, timeoutMs: CHECK_TIMEOUT_MS },
  );
  if (!signature.ok) return { ok: false, message: signature.error.message };
  return { ok: true, manifest: manifest.value, signature: signature.value };
};

export async function createUpdater({
  fetchManifest = fetchManifestHere,
  releases,
  storeOwner,
  untrusted = null,
  disabled,
  builtIn,
  source,
  trust,
  supervisorProtocol,
  runInstaller,
  log,
  now = () => new Date(),
}: {
  releases: string;
  /** Who owns the store and every installed release: root, or this user when all is one. */
  storeOwner: number;
  /**
   * Why the store cannot be trusted (its layout was refused), or null: then nothing is read from
   * it, neither the state nor any release, and only the built-in release runs.
   */
  untrusted?: string | null;
  /**
   * Why in-app updates are off for this installation whatever else holds, such as every process
   * running as one user (Users); null when they are not. Installed releases still start.
   */
  disabled: string | null;
  builtIn: { root: string; build: BuildInfo | null };
  source: UpdateSource;
  trust: { ok: true; value: TrustRoot } | { ok: false; message: string };
  supervisorProtocol: number;
  runInstaller: RunInstaller;
  /** How manifests are fetched: in the installer process when the supervisor is root. */
  fetchManifest?: FetchManifest;
  log: (line: string) => void;
  now?: () => Date;
}) {
  const builtInSequence = builtIn.build?.sequence ?? 0;
  /** The releases this image takes: those of its repository and channel. */
  const identity: ReleaseIdentity | null = builtIn.build
    ? { repository: builtIn.build.repository, channel: builtIn.build.channel }
    : null;
  try {
    await mkdir(releases, { recursive: true, mode: 0o755 });
  } catch (error) {
    // Reading finds no state then; writing it fails the step that needed it, with the reason.
    log(
      `could not create ${releases} (${error instanceof Error ? error.message : String(error)}), so no update can be installed or recorded there`,
    );
  }
  // An untrusted store gives nothing: no state, no release (see `untrusted`).
  const read = untrusted
    ? { ok: false as const, message: untrusted }
    : await ReleaseStore.read(releases, ReleaseStore.empty());
  if (!read.ok) log(read.message);
  let state: ReleaseState = read.ok ? read.value : ReleaseStore.empty();
  /**
   * Why the state cannot be trusted: then the watermark is unknown, so the built-in release runs,
   * nothing installs or rolls back, and the damaged file is left for an administrator.
   */
  const stateProblem = read.ok
    ? null
    : `${read.message} Until then Nimbus installs no update and rolls nothing back: without its record of what ran, it cannot tell an update from a downgrade.`;
  /** The highest sequence run of this image's identity in `of`, the built-in release's included. */
  const watermarkOf = (of: ReleaseState) =>
    Math.max(
      builtInSequence,
      identity ? (of.watermarks[ReleaseStore.watermarkKey(identity)] ?? 0) : 0,
    );
  const watermark = () => watermarkOf(state);
  /** Installed releases' manifests, as verified when they were chosen. */
  const known = new Map<string, ReleaseManifest>();
  let offered: Offered | null = null;
  let available: UpdateStatus["available"] = null;

  const unavailable = disabled
    ? disabled
    : !trust.ok
      ? trust.message
      : trust.value.keys.size === 0
        ? "This image trusts no release key (apps/web/release-keys.json lists none), so it installs no update. Use an image built with a release key."
        : !builtIn.build
          ? "This image has no build metadata (build-info.json), so it does not know its channel. Use an image built by CI."
          : null;
  /** Why nothing may install or roll back now. */
  /**
   * Why the watermark could not be kept this run: a floor or an activation that could not be
   * written. Then nothing installs or rolls back until the supervisor starts again.
   */
  let unrecorded: string | null = null;
  const blocked = () => unavailable ?? stateProblem ?? unrecorded;
  /** Write `change`, and turn updates off for the run when the write fails. */
  const record = async (
    change: (current: ReleaseState) => ReleaseState,
  ): Promise<Done> => {
    const written = await save(change);
    if (!written.ok)
      unrecorded ??= `Nimbus could not record which release runs (${written.message}), so it installs and rolls back nothing until it restarts; the running release keeps serving.`;
    return written;
  };

  /** Writes, one after another. */
  let writing: Promise<unknown> = Promise.resolve();
  /**
   * Write `change(state)` as the new state, after any write under way; memory follows disk. The
   * change sees the state as it stands when its turn comes, and may refuse instead, writing
   * nothing, so a decision and the write it leads to are one step.
   */
  const save = (
    change: (current: ReleaseState) => ReleaseState | { refused: string },
  ): Promise<Done> => {
    const written = writing.then(async (): Promise<Done> => {
      if (stateProblem) return { ok: false, message: stateProblem };
      const next = change(state);
      if ("refused" in next) return { ok: false, message: next.refused };
      if (next === state) return { ok: true };
      try {
        await ReleaseStore.write(releases, next);
      } catch (error) {
        const message = `Nimbus could not record the update state in ${releases} (${error instanceof Error ? error.message : String(error)}), so this step did not happen. Check that the folder is writable.`;
        log(message);
        return { ok: false, message };
      }
      state = next;
      return { ok: true };
    });
    writing = written;
    return written;
  };
  /** `state` with `sequence` as this identity's watermark, if higher. */
  const raised = (current: ReleaseState, sequence: number): ReleaseState =>
    identity
      ? {
          ...current,
          watermarks: {
            ...current.watermarks,
            [ReleaseStore.watermarkKey(identity)]: Math.max(
              builtInSequence,
              current.watermarks[ReleaseStore.watermarkKey(identity)] ?? 0,
              sequence,
            ),
          },
        }
      : current;

  /** Installed release `name` if it verifies and this image can run it, else why not. */
  const runnable = async (name: string) => {
    if (untrusted) return { ok: false as const, message: untrusted };
    if (!trust.ok) return { ok: false as const, message: trust.message };
    if (!identity)
      return {
        ok: false as const,
        message:
          "this image has no build metadata, so it does not know which releases are its own",
      };
    const verified = await ReleaseStore.verified(releases, name, trust.value);
    if (!verified.ok) return verified;
    const other = UpdateOffer.sameIdentity(verified.manifest, identity);
    if (other !== null)
      return {
        ok: false as const,
        message: `release ${name} is not this image's: ${other}`,
      };
    const { abi, locations } = await ImageAbi.read(
      builtIn.root,
      supervisorProtocol,
      Object.keys(verified.manifest.requires.native),
    );
    const missing = UpdateOffer.missing(verified.manifest.requires, abi);
    if (missing.length)
      return {
        ok: false as const,
        message: `release ${name} needs ${missing.join("; ")}`,
      };
    // Every file, against the tree that was signed, before any of it runs.
    const intact = await ReleaseStore.intact(
      verified.root,
      verified.manifest,
      locations,
      storeOwner,
    );
    if (!intact.ok) return intact;
    known.set(name, verified.manifest);
    return {
      ok: true as const,
      root: verified.root,
      manifest: verified.manifest,
    };
  };

  const status = (): UpdateStatus => {
    const running = state.current;
    const manifest = running ? known.get(running) : null;
    return {
      running: running
        ? {
            name: running,
            sequence: manifest?.build.sequence ?? null,
            commit: manifest?.build.commit ?? null,
          }
        : {
            name: "built-in",
            sequence: builtIn.build?.sequence ?? null,
            commit: builtIn.build?.commit ?? null,
          },
      channel: builtIn.build?.channel ?? null,
      source:
        source.kind === "off"
          ? source
          : { kind: "url", url: source.base.href, origin: source.origin },
      unavailable: blocked(),
      lastCheck: state.lastCheck,
      available,
      previous: state.previous,
      schedule: state.schedule,
    };
  };

  return {
    /**
     * The release servers start from at boot: the one that ran last, unless the image's built-in
     * release is as new or newer (a newer image was pulled), it no longer verifies, or the state
     * is damaged. Null for the built-in one.
     */
    async startRelease(): Promise<{ name: string; root: string } | null> {
      if (stateProblem) return null;
      // A switch interrupted after every server stopped: its migrations may be applied already.
      if (state.pending !== null) {
        const pending = await runnable(state.pending);
        if (pending.ok && pending.manifest.build.sequence > builtInSequence) {
          log(
            `starting ${state.pending}, which the supervisor was switching to when it stopped`,
          );
          return { name: state.pending, root: pending.root };
        }
        log(
          `not starting ${state.pending}, which the supervisor was switching to: ${pending.ok ? "the image's own release is as new" : pending.message}`,
        );
      }
      if (state.current === null) return null;
      const chosen = await runnable(state.current);
      if (!chosen.ok) {
        log(
          `starting the image's built-in release instead of ${state.current}: ${chosen.message}`,
        );
        return null;
      }
      if (chosen.manifest.build.sequence <= builtInSequence) {
        log(
          `starting the image's built-in release (build ${builtInSequence}): it is as new as or newer than ${state.current}`,
        );
        await save((current) => ({
          ...current,
          current: null,
          previous: current.current,
        }));
        return null;
      }
      return { name: state.current, root: chosen.root };
    },

    /** The root of installed release `name`, verified, for a handover to it. */
    resolve: runnable,

    /** Ask the update source for the newest release, and say what it means here. */
    async check(): Promise<
      { ok: true; status: UpdateStatus } | { ok: false; message: string }
    > {
      if (unavailable) return { ok: false, message: unavailable };
      if (source.kind === "off") return { ok: false, message: source.reason };
      if (!trust.ok || !identity)
        return { ok: false, message: "Updates are unavailable." };
      const at = now().toISOString();
      // When the check is recorded is for the administrator; a damaged state is not rewritten.
      const record = (outcome: string) =>
        stateProblem
          ? Promise.resolve()
          : save((current) => ({ ...current, lastCheck: { at, outcome } }));
      const fail = async (message: string) => {
        await record(message);
        return { ok: false as const, message };
      };
      const fetched = await fetchManifest(source);
      if (!fetched.ok) return fail(fetched.message);
      // Whoever fetched them, they are bytes: bounded again here, then verified.
      if (
        fetched.manifest.byteLength > MAX_MANIFEST_BYTES ||
        fetched.signature.byteLength > MAX_SIGNATURE_BYTES
      )
        return fail(
          "The update source sent a manifest or signature larger than any release has, so it was not read.",
        );
      const bytes = { value: fetched.manifest };
      const signature = { value: fetched.signature };
      const signed = await ReleaseSignature.verify(
        trust.value,
        bytes.value,
        signature.value,
      );
      if (!signed.ok) return fail(signed.error.message);
      const parsed = ReleaseManifest.parse(bytes.value);
      if (!parsed.ok) return fail(parsed.error.message);
      const { abi } = await ImageAbi.read(
        builtIn.root,
        supervisorProtocol,
        Object.keys(parsed.value.requires.native),
      );
      const offer = UpdateOffer.decide({
        manifest: parsed.value,
        identity,
        highestRun: watermark(),
        image: abi,
      });
      const message = UpdateOffer.describe(offer);
      offered =
        offer.kind === "offer"
          ? {
              manifest: parsed.value,
              bytes: bytes.value,
              signature: signature.value,
            }
          : null;
      available =
        offer.kind === "offer" || offer.kind === "needs-newer-image"
          ? {
              kind: offer.kind,
              build: parsed.value.build,
              notes: parsed.value.notes,
              message,
            }
          : null;
      await record(message);
      return { ok: true, status: status() };
    },

    /**
     * Install what the last check offered. Once installed it is checked to be newer still than
     * anything run meanwhile, and its sequence is recorded durably as run before the caller hands
     * over to the name it returns: a failure after this never lets an older release back in.
     */
    async install(): Promise<
      { ok: true; name: string } | { ok: false; message: string }
    > {
      const off = blocked();
      if (off) return { ok: false, message: off };
      if (source.kind === "off") return { ok: false, message: source.reason };
      if (!offered)
        return {
          ok: false,
          message:
            available?.kind === "needs-newer-image"
              ? available.message
              : "There is no update to install: check for updates first.",
        };
      const { manifest, bytes, signature } = offered;
      log(
        `installing build ${manifest.build.sequence} (${manifest.build.commit.slice(0, 12)})`,
      );
      const installed = await runInstaller({
        releases,
        source: source.base.href,
        manifest: Buffer.from(bytes).toString("base64"),
        signature: Buffer.from(signature).toString("base64"),
      });
      if (!installed.ok) return installed;
      // Compared and reserved in one write, against what ran by the time its turn comes.
      const reserved = await save((current) =>
        manifest.build.sequence <= watermarkOf(current)
          ? {
              refused: `Build ${manifest.build.sequence} was installed but is no longer newer than what ran here meanwhile (build ${watermarkOf(current)}), so it was not started.`,
            }
          : raised(current, manifest.build.sequence),
      );
      if (!reserved.ok) return reserved;
      known.set(installed.name, manifest);
      return installed;
    },

    /** Record that servers now run `name` (null for built-in), after a handover to it. */
    async ran(name: string | null): Promise<Done> {
      const sequence =
        name === null
          ? builtInSequence
          : (known.get(name)?.build.sequence ?? 0);
      // The release the last check offered runs now: what that check said is no longer true.
      const caughtUp =
        offered &&
        name !== null &&
        ReleaseManifest.releaseName(offered.manifest) === name
          ? offered.manifest.build
          : null;
      if (caughtUp) {
        offered = null;
        available = null;
      }
      // Compared with the state as it stands when this write's turn comes, not when it was asked.
      return record((current) =>
        current.current === name && current.pending !== name
          ? current
          : {
              ...raised(current, sequence),
              current: name,
              lastCheck:
                caughtUp && current.lastCheck
                  ? {
                      at: current.lastCheck.at,
                      outcome: `Nimbus is up to date: build ${caughtUp.sequence} (${caughtUp.commit.slice(0, 12)}), the newest that check found, runs now.`,
                    }
                  : current.lastCheck,
              // What ran before: the image's own release when nothing installed did.
              previous:
                current.current === name
                  ? current.previous
                  : (current.current ?? BUILT_IN),
              pending: current.pending === name ? null : current.pending,
            },
      );
    },

    /**
     * Record the image's own build as run, before any server starts: a newer image pulled once
     * keeps its floor when an older one is started later.
     */
    recordFloor: (): Promise<Done> =>
      record((current) =>
        identity &&
        builtInSequence >
          (current.watermarks[ReleaseStore.watermarkKey(identity)] ?? 0)
          ? raised(current, builtInSequence)
          : current,
      ),

    /** Set when updates are looked for and installed on their own. */
    setSchedule: (schedule: UpdateSchedule): Promise<Done> =>
      save((current) => ({ ...current, schedule })),

    /** Record that the automatic install of `day` is being tried, so it is tried once that day. */
    markAutomatic: (day: string): Promise<Done> =>
      save((current) => ({ ...current, lastAutomatic: day })),

    /** What the schedule needs to decide: when the source was last asked, and what it offered. */
    scheduling: () => ({
      schedule: state.schedule,
      lastCheckAt: state.lastCheck?.at ?? null,
      lastAutomatic: state.lastAutomatic,
      offered: offered !== null,
    }),

    /** Why nothing may install, roll back or be handed over to by name now, or null. */
    blocked,

    /** Record that a handover to installed release `name` is starting (see ReleaseState). */
    markPending: (name: string): Promise<Done> =>
      save((current) => ({ ...current, pending: name })),

    /** Forget a handover to `name` that ended with the earlier release still serving. */
    clearPending: (name: string): Promise<Done> =>
      save((current) =>
        current.pending === name ? { ...current, pending: null } : current,
      ),

    /** The release a rollback returns to: the one that ran before, or the built-in one. */
    async rollbackTarget(): Promise<
      { ok: true; name: string | null } | { ok: false; message: string }
    > {
      // After any record still being written, such as the activation of the release now running.
      await writing;
      const off = stateProblem ?? unrecorded;
      if (off) return { ok: false, message: off };
      if (state.previous === null && state.current === null)
        return {
          ok: false,
          message:
            "There is no earlier release to roll back to: the built-in release runs and nothing ran before it.",
        };
      // A state from before the image's own release was recorded by name means it.
      return { ok: true, name: state.previous ?? BUILT_IN };
    },

    /** Remove installed releases no longer needed; `running` are ones servers still run. */
    async prune(running: readonly string[]) {
      const keep = new Set([
        ...running,
        ...(state.current ? [state.current] : []),
        ...(state.previous ? [state.previous] : []),
      ]);
      if (!trust.ok) return;
      for (const removed of await ReleaseStore.prune(
        releases,
        keep,
        trust.value,
      ))
        log(`removed ${removed} from ${releases}`);
    },

    status,
  };
}

export type Updater = Awaited<ReturnType<typeof createUpdater>>;
