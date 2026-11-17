import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isFsError } from "./safe-path";

/**
 * Where content is written before it is renamed into the drive. A rename only works within
 * one filesystem, and a folder of the drive may be its own filesystem (a disk or share mounted
 * inside it), so each filesystem stages in `.nimbus/uploads` at its top folder in the drive:
 * the data root, or the mounted folder. Nimbus hides `.nimbus` at every depth.
 */
async function deviceOf(absolute: string) {
  return (await stat(absolute)).dev;
}

/** The data root's device, read once per root: writes stat on every commit otherwise. */
const rootDevices = new Map<string, number>();
async function rootDevice(dataRoot: string) {
  let device = rootDevices.get(dataRoot);
  if (device === undefined) {
    device = await deviceOf(dataRoot);
    rootDevices.set(dataRoot, device);
  }
  return device;
}

const rootStaging = (dataRoot: string) =>
  path.join(dataRoot, ".nimbus", "uploads");

/** The nearest existing folder at or above `absolute`, stopping at the data root. */
async function existingFolder(dataRoot: string, absolute: string) {
  for (let folder = absolute; ; folder = path.dirname(folder)) {
    try {
      if ((await stat(folder)).isDirectory()) return folder;
    } catch (error) {
      if (!isFsError(error, "ENOENT") && !isFsError(error, "ENOTDIR"))
        throw error;
    }
    if (folder === dataRoot || path.dirname(folder) === folder) return dataRoot;
  }
}

/** The staging folder on the filesystem that holds `target`, an absolute path in the drive. */
async function directoryFor(dataRoot: string, target: string) {
  let top = await existingFolder(dataRoot, path.dirname(target));
  const device = await deviceOf(top);
  if (device === (await rootDevice(dataRoot))) top = dataRoot;
  // Otherwise walk up to the mounted folder: the highest one on the same filesystem.
  else
    while (
      top !== dataRoot &&
      path.dirname(top) !== top &&
      (await deviceOf(path.dirname(top))) === device
    )
      top = path.dirname(top);
  const directory = rootStaging(top);
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * `incoming` as a file on the filesystem of `target`, so it can be renamed there: `incoming`
 * itself when it already is, otherwise a copy in that filesystem's staging folder, removed by
 * `discard`.
 */
async function onFilesystemOf(
  dataRoot: string,
  incoming: string,
  target: string,
): Promise<{ path: string; discard: () => Promise<void> }> {
  const folder = await existingFolder(dataRoot, path.dirname(target));
  const incomingDevice =
    path.dirname(incoming) === rootStaging(dataRoot)
      ? await rootDevice(dataRoot)
      : await deviceOf(incoming);
  if ((await deviceOf(folder)) === incomingDevice)
    return { path: incoming, discard: async () => {} };
  const copy = path.join(
    await directoryFor(dataRoot, target),
    `${randomUUID()}.incoming`,
  );
  const discard = () => rm(copy, { force: true });
  try {
    await copyFile(incoming, copy);
  } catch (error) {
    await discard();
    throw error;
  }
  return { path: copy, discard };
}

export const Staging = { directoryFor, onFilesystemOf } as const;
