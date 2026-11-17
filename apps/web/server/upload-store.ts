import { FileStore } from "@tus/file-store";
import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { getDataRoot } from "@nimbus/api/data-root";
import { isFsError } from "@nimbus/api/safe-path";
import { Staging } from "@nimbus/api/staging";

// Errors from filesystems or nested mounts that cannot hardlink or rename between each other.
const crossDevice = ["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EPERM"];

export class UploadStore extends FileStore {
  async isFinished(id: string) {
    try {
      await readFile(path.join(this.directory, `${id}.done`));
      return true;
    } catch (error) {
      if (isFsError(error, "ENOENT")) return false;
      throw error;
    }
  }

  /** Where a finished upload was published, as its marker recorded, or null if unfinished. */
  async publishedTo(id: string) {
    try {
      return await readFile(path.join(this.directory, `${id}.done`), "utf8");
    } catch (error) {
      if (isFsError(error, "ENOENT")) return null;
      throw error;
    }
  }

  override async getUpload(id: string) {
    const upload = await super.getUpload(id);
    // Published files may be edited by other programs. Keep the tus offset fixed
    // at the original length so retries cannot write through the staging link.
    if (upload.size !== undefined && (await this.isFinished(id))) {
      upload.offset = upload.size;
    }
    return upload;
  }

  async isPublishedAt(id: string, destination: string) {
    const [staged, existing] = await Promise.all([
      lstat(path.join(this.directory, id)),
      lstat(destination),
    ]);
    return (
      existing.isFile() &&
      staged.dev === existing.dev &&
      staged.ino === existing.ino
    );
  }

  async publish(id: string, destination: string) {
    if (await this.isFinished(id)) return;
    const source = path.join(this.directory, id);
    let copied = false;
    try {
      // link is atomic and refuses to overwrite an existing destination. Retain
      // the staging name for tus HEAD/PATCH retries without duplicating bytes.
      await link(source, destination);
    } catch (error) {
      if (isFsError(error, "EEXIST")) {
        // Recover a completion interrupted after linking but before its marker.
        if (!(await this.isPublishedAt(id, destination))) {
          throw error;
        }
      } else if (crossDevice.some((code) => isFsError(error, code))) {
        // A nested mount, or a filesystem without hardlinks: copy onto the destination's
        // filesystem first, so the file appears whole, never half written.
        const incoming = await Staging.onFilesystemOf(
          getDataRoot(),
          source,
          destination,
        );
        try {
          await link(incoming.path, destination);
        } catch (linkError) {
          if (!crossDevice.some((code) => isFsError(linkError, code)))
            throw linkError;
          await copyFile(incoming.path, destination, constants.COPYFILE_EXCL);
        } finally {
          await incoming.discard();
        }
        copied = true;
      } else {
        throw error;
      }
    }
    await this.markFinished(id, destination, copied);
  }

  /**
   * Publish over an existing file. `commit` moves the staged content over the destination,
   * atomically on the same filesystem; it defaults to a plain rename.
   */
  async replace(
    id: string,
    destination: string,
    commit: (incoming: string) => Promise<unknown> = (incoming) =>
      rename(incoming, destination),
  ) {
    if (await this.isFinished(id)) return;
    const source = path.join(this.directory, id);
    // On a folder mounted inside the drive, the staged bytes are copied onto its filesystem,
    // so the commit still renames them into place and keeps the replaced content as a version.
    const incoming = await Staging.onFilesystemOf(
      getDataRoot(),
      source,
      destination,
    );
    const temporary = path.join(this.directory, `${id}.replace`);
    try {
      if (incoming.path === source) {
        // The staged file stays for tus retries; the commit renames a second name away.
        await rm(temporary, { force: true });
        try {
          await link(source, temporary);
        } catch (error) {
          if (!crossDevice.some((code) => isFsError(error, code))) throw error;
          await copyFile(source, temporary);
        }
        await commit(temporary);
      } else await commit(incoming.path);
    } finally {
      await rm(temporary, { force: true });
      await incoming.discard();
    }
    // A failed marker leaves the replaced content in place; a retry replaces it again.
    await this.markFinished(id, destination, false);
  }

  private async markFinished(
    id: string,
    destination: string,
    removeOnFailure: boolean,
  ) {
    const marker = path.join(this.directory, `${id}.done`);
    const temporaryMarker = `${marker}.tmp`;
    try {
      await writeFile(temporaryMarker, destination);
      await rename(temporaryMarker, marker);
    } catch (error) {
      // Copies cannot be recognized by inode on retry. Remove only the new copy;
      // the complete staged upload remains available for another attempt.
      if (removeOnFailure) await unlink(destination);
      throw error;
    } finally {
      await rm(temporaryMarker, { force: true });
    }
  }
}
