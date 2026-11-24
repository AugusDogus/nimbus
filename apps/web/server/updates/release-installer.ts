import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
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

/** A bundle download may take this long; a stalled one fails rather than wait forever. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

const describe = (error: unknown) => {
  const code =
    error instanceof Error && "code" in error ? String(error.code) : null;
  if (code === "ENOSPC" || code === "EFBIG")
    return "the disk holding the releases is full or limits how large a file may grow. Free space on it, then install again";
  if (code === "EACCES" || code === "EPERM")
    return "the supervisor may not write the releases folder. Check its owner, then install again";
  return error instanceof Error ? error.message : String(error);
};

/**
 * Install the release `manifest` describes, which `signature` signs (see docs/updates.md):
 * download its bundle beside the releases, compare its size and SHA-256, unpack it into a staging
 * folder, check the tree, link the image's native packages, and only then rename it into place.
 * Every failure removes what it wrote; the running servers never see any of it.
 */
export async function installRelease({
  releases,
  source,
  manifest: manifestBytes,
  signature,
  trust,
  builtInRoot,
  supervisorProtocol,
}: {
  releases: string;
  source: Extract<UpdateSource, { kind: "url" }>;
  manifest: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
  trust: TrustRoot;
  builtInRoot: string;
  supervisorProtocol: number;
}): Promise<{ ok: true; name: string } | { ok: false; error: InstallError }> {
  // Verified again here, whoever asked: only a signed release is ever written.
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
  await mkdir(releases, { recursive: true, mode: 0o755 });
  /** Whether release `name` is already installed here, whole. */
  const alreadyInstalled = async () => {
    const installed = await ReleaseStore.verified(releases, name, trust);
    return (
      installed.ok &&
      (await ReleaseStore.intact(installed.root, installed.manifest, locations))
        .ok
    );
  };
  if (await alreadyInstalled()) return { ok: true, name };

  // This attempt's own folder: another install running at the same time never shares a path.
  let attempt: string;
  try {
    attempt = await mkdtemp(path.join(releases, `.install-${name}-`));
  } catch (error) {
    return failed(`Release ${name} was not installed: ${describe(error)}.`);
  }
  const staging = path.join(attempt, "release");
  const cleanUp = () => rm(attempt, { recursive: true, force: true });
  try {
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
    const downloadPath = path.join(attempt, "bundle.tar.gz");
    const download = await open(downloadPath, "wx+", 0o600);
    try {
      await unlink(downloadPath);
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
              {
                code: "ENOSPC",
              },
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
      await mkdir(staging, { mode: 0o755 });
      const unpacked = await BundleArchive.unpack(readFrom(download), staging);
      if (!unpacked.ok)
        return failed(
          `The bundle of release ${name} could not be unpacked: ${unpacked.error.message}`,
        );
    } finally {
      await download.close();
    }
    const binaries = await NativeArtifacts.find(staging);
    if (binaries.length)
      return failed(
        `The bundle of release ${name} carries native binaries (${binaries.slice(0, 5).join(", ")}${binaries.length > 5 ? ", …" : ""}), which only the image may provide. Nothing was installed.`,
      );
    const unpackedTree = await ReleaseTree.digest(staging);
    if (
      unpackedTree.sha256 !== manifest.tree.sha256 ||
      unpackedTree.entries !== manifest.tree.entries
    )
      return failed(
        `The bundle of release ${name} unpacks to another tree than its signed manifest describes. Nothing was installed.`,
      );
    const tree = ReleaseDirectory.check(staging);
    if (!tree.ok)
      return failed(
        `The bundle of release ${name} is not a release: ${tree.reason}.`,
      );
    const build = await BuildInfo.read(path.join(staging, "apps/web"));
    if (
      !build.ok ||
      !build.value ||
      build.value.commit !== manifest.build.commit ||
      build.value.sequence !== manifest.build.sequence ||
      build.value.channel !== manifest.build.channel
    )
      return failed(
        `The bundle of release ${name} describes another build than its manifest. Nothing was installed.`,
      );
    for (const [native, location] of locations) {
      const link = path.join(staging, "apps/web/node_modules", native);
      // Never written through a link the bundle put on the way.
      for (
        let folder = path.dirname(link);
        folder !== staging;
        folder = path.dirname(folder)
      )
        if ((await lstat(folder).catch(() => null))?.isSymbolicLink())
          return failed(
            `The bundle of release ${name} holds ${path.relative(staging, folder)}, which is a link: the installer does not link native packages through it.`,
          );
      if (await lstat(link).catch(() => null))
        return failed(
          `The bundle of release ${name} carries ${native}, which the image provides.`,
        );
      // The bundle's own folder for it: one the installer made would not be in the signed tree.
      if (!(await lstat(path.dirname(link)).catch(() => null))?.isDirectory())
        return failed(
          `The bundle of release ${name} has no ${path.relative(staging, path.dirname(link))} folder for the native packages the image provides.`,
        );
      await symlink(location, link);
    }
    // Created, never written over: a bundle holding these names is refused.
    await writeFile(path.join(staging, MANIFEST_FILE), manifestBytes, {
      mode: 0o644,
      flag: "wx",
    });
    await writeFile(path.join(staging, SIGNATURE_FILE), signature, {
      mode: 0o644,
      flag: "wx",
    });
    try {
      await rename(staging, path.join(releases, name));
    } catch (error) {
      // Another install of this release finished first: keep its copy if it verifies.
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOTEMPTY" || error.code === "EEXIST") &&
        (await alreadyInstalled())
      )
        return { ok: true, name };
      throw error;
    }
    return { ok: true, name };
  } catch (error) {
    return failed(`Release ${name} was not installed: ${describe(error)}.`);
  } finally {
    await cleanUp();
  }
}
