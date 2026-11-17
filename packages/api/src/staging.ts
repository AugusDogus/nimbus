import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { isFsError, isWithinPath } from "./safe-path";

/**
 * Where content is written before it is renamed into the drive. A rename only works within one
 * mount of one filesystem: a folder mounted inside the drive (a disk, a share, or a bind mount
 * of another folder) or a btrfs subvolume refuses renames from outside it. So each such place
 * stages in `.nimbus/uploads` at its top folder in the drive: the data root, or the mounted
 * folder. Nimbus hides `.nimbus` at every depth, and maintenance cleans every staging folder.
 */

/** A folder's filesystem and mount. Renames work only between folders of the same place. */
type Place = { device: number; mount: string | null };

/** Absolute paths compared as drive-style relative ones, where "" is the filesystem root. */
const within = (parent: string, child: string) =>
  isWithinPath(parent.slice(1), child.slice(1));

/** Mount points from /proc/self/mountinfo, reread at most once a second; null off Linux. */
let mounts: { points: string[] | null; readAt: number } | null = null;
async function mountPoints() {
  if (mounts && Date.now() - mounts.readAt < 1000) return mounts.points;
  let points: string[] | null;
  try {
    const table = await readFile("/proc/self/mountinfo", "utf8");
    points = table
      .split("\n")
      .flatMap((line) => {
        const field = line.split(" ")[4];
        return field ? [field] : [];
      })
      // Spaces and other special characters are written as octal escapes, such as \040.
      .map((point) =>
        point.replace(/\\([0-7]{3})/g, (_, octal: string) =>
          String.fromCharCode(Number.parseInt(octal, 8)),
        ),
      );
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error;
    points = null;
  }
  mounts = { points, readAt: Date.now() };
  return points;
}

async function placeOf(folder: string): Promise<Place> {
  const [details, real, points] = await Promise.all([
    stat(folder),
    realpath(folder),
    mountPoints(),
  ]);
  // The innermost mount point containing the folder.
  let mount: string | null = null;
  for (const point of points ?? [])
    if (within(point, real) && (mount === null || point.length > mount.length))
      mount = point;
  return { device: details.dev, mount };
}

/** The data root's place, read at most once a second: every staged write compares with it. */
const rootPlaces = new Map<string, { place: Place; readAt: number }>();
async function rootPlace(dataRoot: string) {
  const cached = rootPlaces.get(dataRoot);
  if (cached && Date.now() - cached.readAt < 1000) return cached.place;
  const place = await placeOf(dataRoot);
  rootPlaces.set(dataRoot, { place, readAt: Date.now() });
  return place;
}

const samePlace = (a: Place, b: Place) =>
  a.device === b.device && a.mount === b.mount;

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

/** The staging folder for renames into the folder holding `target`, an absolute drive path. */
async function directoryFor(dataRoot: string, target: string) {
  const folder = await existingFolder(dataRoot, path.dirname(target));
  const place = await placeOf(folder);
  let top = dataRoot;
  if (!samePlace(place, await rootPlace(dataRoot))) {
    // The highest folder of the drive in the same place as the target's folder.
    top = folder;
    while (
      top !== dataRoot &&
      path.dirname(top) !== top &&
      samePlace(await placeOf(path.dirname(top)), place)
    )
      top = path.dirname(top);
  }
  const directory = rootStaging(top);
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * `incoming` as a file that can be renamed into the folder of `target`: `incoming` itself when
 * it can be, otherwise a copy in that place's staging folder, removed by `discard`.
 */
async function onFilesystemOf(
  dataRoot: string,
  incoming: string,
  target: string,
): Promise<{ path: string; discard: () => Promise<void> }> {
  const [from, to] = await Promise.all([
    path.dirname(incoming) === rootStaging(dataRoot)
      ? rootPlace(dataRoot)
      : placeOf(path.dirname(incoming)),
    existingFolder(dataRoot, path.dirname(target)).then(placeOf),
  ]);
  if (samePlace(from, to)) return { path: incoming, discard: async () => {} };
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

/**
 * Every staging folder that may exist: the data root's and one in each folder mounted inside
 * the drive. Staging in a btrfs subvolume that is not a mount point is not listed.
 */
async function directories(dataRoot: string) {
  const real = await realpath(dataRoot);
  const mounted = ((await mountPoints()) ?? []).filter(
    (point) => point !== real && within(real, point),
  );
  return [
    rootStaging(dataRoot),
    ...mounted.map((point) =>
      rootStaging(path.join(dataRoot, path.relative(real, point))),
    ),
  ];
}

export const Staging = { directoryFor, onFilesystemOf, directories } as const;
