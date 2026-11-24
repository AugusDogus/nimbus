import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { ReleaseDirectory } from "../supervisor/release-directory";
import { BundleArchive } from "./bundle-archive";
import { BuildInfo } from "./build-info";
import { ImageAbi } from "./image-abi";
import { NativeArtifacts } from "./native-artifacts";
import { ReleaseCopy } from "./release-copy";
import { ReleaseTree } from "./release-tree";
import { ReleaseManifest } from "./release-manifest";
import { ReleaseSignature, type TrustRoot } from "./release-signature";
import { MANIFEST_FILE, ReleaseStore, SIGNATURE_FILE } from "./release-store";
import { UpdateOffer } from "./update-offer";
import { UpdateSource } from "./update-source";

export type InstallError = { kind: "install-failed"; message: string };

const failed = (message: string): { ok: false; error: InstallError } => ({
  ok: false,
  error: { kind: "install-failed", message },
});

/** The whole of `file` from its start, read by position through its descriptor. */
function readFrom(file: FileHandle) {
  let position = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const buffer = new Uint8Array(1024 * 1024);
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (bytesRead === 0) controller.close();
      else {
        position += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      }
    },
  });
}

/** Who publishes: root's copy belongs to this process's user, which must own every entry. */
const self = process.getuid?.() ?? -1;

/** A bundle download may take this long; a stalled one fails rather than wait forever. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

const describe = (error: unknown) => {
  const code =
    error instanceof Error && "code" in error ? String(error.code) : null;
  if (code === "ENOSPC" || code === "EFBIG")
    return "the disk holding the releases is full or limits how large a file may grow. Free space on it, then install again";
  if (code === "EACCES" || code === "EPERM")
    return "the update store's folders do not let this step write where it must. Check their owners (see docs/updates.md), then install again";
  return error instanceof Error ? error.message : String(error);
};

/** What checking a signed manifest against this image gives: the manifest, or why not. */
async function signedFor({
  manifest: manifestBytes,
  signature,
  trust,
  builtInRoot,
  supervisorProtocol,
}: {
  manifest: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
  trust: TrustRoot;
  builtInRoot: string;
  supervisorProtocol: number;
}) {
  const signed = await ReleaseSignature.verify(trust, manifestBytes, signature);
  if (!signed.ok) return failed(signed.error.message);
  const parsed = ReleaseManifest.parse(manifestBytes);
  if (!parsed.ok) return failed(parsed.error.message);
  const manifest = parsed.value;
  const name = ReleaseManifest.releaseName(manifest);
  // Only a release of the image's own repository and channel, whoever signed it.
  const image = await BuildInfo.read(path.join(builtInRoot, "apps/web"));
  if (!image.ok || !image.value)
    return failed(
      "This image has no build metadata, so it does not know which releases are its own. Nothing was installed.",
    );
  const other = UpdateOffer.sameIdentity(manifest, image.value);
  if (other !== null)
    return failed(
      `Release ${name} is not this image's: ${other}. Nothing was installed.`,
    );
  const { abi, locations } = await ImageAbi.read(
    builtInRoot,
    supervisorProtocol,
    Object.keys(manifest.requires.native),
  );
  const missing = UpdateOffer.missing(manifest.requires, abi);
  if (missing.length)
    return failed(
      `Release ${name} needs ${missing.join("; ")}. Pull ${manifest.requires.image} and recreate the container to get it.`,
    );
  return { ok: true as const, manifest, name, locations };
}

/** Whether `tree` is release `manifest` describes, as signed; why not otherwise. */
async function sameTree(tree: string, manifest: ReleaseManifest, name: string) {
  const binaries = await NativeArtifacts.find(tree);
  if (binaries.length)
    return `The bundle of release ${name} carries native binaries (${binaries.slice(0, 5).join(", ")}${binaries.length > 5 ? ", …" : ""}), which only the image may provide. Nothing was installed.`;
  const digest = await ReleaseTree.digest(tree);
  if (
    digest.sha256 !== manifest.tree.sha256 ||
    digest.entries !== manifest.tree.entries
  )
    return `The bundle of release ${name} unpacks to another tree than its signed manifest describes. Nothing was installed.`;
  const checked = ReleaseDirectory.check(tree);
  if (!checked.ok)
    return `The bundle of release ${name} is not a release: ${checked.reason}.`;
  const build = await BuildInfo.read(path.join(tree, "apps/web"));
  if (
    !build.ok ||
    !build.value ||
    build.value.commit !== manifest.build.commit ||
    build.value.sequence !== manifest.build.sequence ||
    build.value.channel !== manifest.build.channel
  )
    return `The bundle of release ${name} describes another build than its manifest. Nothing was installed.`;
  return null;
}

/**
 * Stage the release `manifest` describes, which `signature` signs (see docs/updates.md): the
 * installer's part, run as the update user, which alone touches the network and the bundle's
 * bytes. Downloads the bundle into `staging`, compares its size and SHA-256, unpacks it into
 * `<staging>/release` and checks that tree. Nothing it leaves is trusted: root copies and checks
 * it again before anything of it can run (`publishRelease`).
 */
export async function stageRelease({
  staging,
  source,
  ...request
}: {
  staging: string;
  source: Extract<UpdateSource, { kind: "url" }>;
  manifest: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
  trust: TrustRoot;
  builtInRoot: string;
  supervisorProtocol: number;
}): Promise<{ ok: true; name: string } | { ok: false; error: InstallError }> {
  const checked = await signedFor(request);
  if (!checked.ok) return checked;
  const { manifest, name } = checked;
  const tree = path.join(staging, "release");
  try {
    // An earlier attempt's leftovers are this user's own.
    await rm(tree, { recursive: true, force: true });
    const fetched = await UpdateSource.fetch(
      UpdateSource.url(source, manifest.bundle.file),
      {
        maxBytes: manifest.bundle.size,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      },
    );
    if (!fetched.ok) return failed(fetched.error.message);
    // Opened once and unlinked at once: the bytes hashed and the bytes unpacked are read through
    // this one descriptor, and no path leads to them meanwhile.
    const downloadPath = path.join(
      await mkdtemp(path.join(staging, "download-")),
      "bundle.tar.gz",
    );
    const download = await open(downloadPath, "wx+", 0o600);
    try {
      await unlink(downloadPath);
      await rm(path.dirname(downloadPath), { recursive: true, force: true });
      let written = 0;
      for await (const chunk of fetched.value)
        // A write may take only part of a chunk, as near a full disk or a file size limit.
        for (let offset = 0; offset < chunk.byteLength;) {
          const { bytesWritten } = await download.write(
            chunk,
            offset,
            chunk.byteLength - offset,
            written,
          );
          if (bytesWritten === 0)
            throw Object.assign(
              new Error("No byte of the bundle could be written."),
              { code: "ENOSPC" },
            );
          offset += bytesWritten;
          written += bytesWritten;
        }
      await download.sync();
      // What is on disk is what gets unpacked, so that is what is compared.
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of readFrom(download)) {
        hash.update(chunk);
        size += chunk.byteLength;
      }
      const sha256 = hash.digest("hex");
      if (size !== manifest.bundle.size || sha256 !== manifest.bundle.sha256)
        return failed(
          `The bundle of release ${name} arrived as ${size} bytes with SHA-256 ${sha256}, not the ${manifest.bundle.size} bytes and ${manifest.bundle.sha256} its signed manifest names: it was cut short or changed. Nothing was installed; check again later.`,
        );
      await mkdir(tree, { mode: 0o755 });
      const unpacked = await BundleArchive.unpack(readFrom(download), tree);
      if (!unpacked.ok)
        return failed(
          `The bundle of release ${name} could not be unpacked: ${unpacked.error.message}`,
        );
    } finally {
      await download.close();
    }
    const wrong = await sameTree(tree, manifest, name);
    if (wrong) return failed(wrong);
    return { ok: true, name };
  } catch (error) {
    return failed(`Release ${name} was not installed: ${describe(error)}.`);
  }
}

/**
 * Publish a staged release: root's part, once the installer exited and no process of the update
 * user (`owner`) is left. Copies `<staging>/release` into a folder of its own under `releases`
 * (ReleaseCopy), checks that copy against the signed manifest, links the image's native
 * packages, writes the manifest and signature root verified itself, and only then renames it
 * into place. Every failure removes what it wrote; `releases` and its state are unchanged.
 */
export async function publishRelease({
  staging,
  releases,
  owner,
  ...request
}: {
  staging: string;
  releases: string;
  owner: number;
  manifest: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
  trust: TrustRoot;
  builtInRoot: string;
  supervisorProtocol: number;
}): Promise<{ ok: true; name: string } | { ok: false; error: InstallError }> {
  const checked = await signedFor(request);
  if (!checked.ok) return checked;
  const { manifest, name, locations } = checked;
  const { manifest: manifestBytes, signature, trust } = request;
  /**
   * Whether release `name` is already installed here, whole, from these very manifest bytes:
   * `other` when a release of that name was installed from another signed manifest.
   */
  const alreadyInstalled = async (): Promise<"same" | "other" | "none"> => {
    const installed = await ReleaseStore.verified(releases, name, trust);
    if (!installed.ok) return "none";
    const bytes = await readFile(path.join(installed.root, MANIFEST_FILE), {
      flag: constants.O_RDONLY | constants.O_NOFOLLOW,
    }).catch(() => null);
    if (!bytes || !Buffer.from(manifestBytes).equals(bytes)) return "other";
    return (
      await ReleaseStore.intact(
        installed.root,
        installed.manifest,
        locations,
        self,
      )
    ).ok
      ? "same"
      : "none";
  };
  const otherCopy = () =>
    failed(
      `A different release named ${name} is already installed, from another signed manifest, so this one was not installed and the installed one was left as it is. Check the update source; if it republished this build, remove ${path.join(releases, name)} and install again.`,
    );
  const before = await alreadyInstalled();
  if (before === "same") return { ok: true, name };
  if (before === "other") return otherCopy();

  let attempt: string;
  try {
    attempt = await mkdtemp(path.join(releases, `.install-${name}-`));
  } catch (error) {
    return failed(`Release ${name} was not installed: ${describe(error)}.`);
  }
  const copy = path.join(attempt, "release");
  try {
    const copied = await ReleaseCopy.copy(path.join(staging, "release"), copy, {
      owner,
      limits: ReleaseCopy.limits,
    });
    if (!copied.ok)
      return failed(`Release ${name} was not installed: ${copied.message}`);
    // Checked again in root's own copy, whatever the installer said of the staged one.
    const wrong = await sameTree(copy, manifest, name);
    if (wrong) return failed(wrong);
    for (const [native, location] of locations) {
      const link = path.join(copy, "apps/web/node_modules", native);
      // Never written through a link the bundle put on the way.
      for (
        let folder = path.dirname(link);
        folder !== copy;
        folder = path.dirname(folder)
      )
        if ((await lstat(folder).catch(() => null))?.isSymbolicLink())
          return failed(
            `The bundle of release ${name} holds ${path.relative(copy, folder)}, which is a link: native packages are not linked through it.`,
          );
      if (await lstat(link).catch(() => null))
        return failed(
          `The bundle of release ${name} carries ${native}, which the image provides.`,
        );
      // The bundle's own folder for it: one made here would not be in the signed tree.
      if (!(await lstat(path.dirname(link)).catch(() => null))?.isDirectory())
        return failed(
          `The bundle of release ${name} has no ${path.relative(copy, path.dirname(link))} folder for the native packages the image provides.`,
        );
      await symlink(location, link);
    }
    // The bytes root verified, created, never written over: a bundle holding these names fails.
    await writeFile(path.join(copy, MANIFEST_FILE), manifestBytes, {
      mode: 0o644,
      flag: "wx",
    });
    await writeFile(path.join(copy, SIGNATURE_FILE), signature, {
      mode: 0o644,
      flag: "wx",
    });
    // Fixed, whatever the umask.
    await chmod(path.join(copy, MANIFEST_FILE), 0o644);
    await chmod(path.join(copy, SIGNATURE_FILE), 0o644);
    const intact = await ReleaseStore.intact(copy, manifest, locations, self);
    if (!intact.ok)
      return failed(`Release ${name} was not installed: ${intact.message}`);
    try {
      await rename(copy, path.join(releases, name));
    } catch (error) {
      // Another install of this release finished first: keep its copy if it verifies.
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOTEMPTY" || error.code === "EEXIST")
      ) {
        const now = await alreadyInstalled();
        if (now === "same") return { ok: true, name };
        if (now === "other") return otherCopy();
      }
      throw error;
    }
    return { ok: true, name };
  } catch (error) {
    return failed(`Release ${name} was not installed: ${describe(error)}.`);
  } finally {
    await rm(attempt, { recursive: true, force: true });
  }
}
