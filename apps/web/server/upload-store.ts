import { FileStore } from "@tus/file-store";
import { constants } from "node:fs";
import { copyFile, link, lstat, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isFsError } from "@nimbus/api/safe-path";

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

  override async getUpload(id: string) {
    const upload = await super.getUpload(id);
    // Published files may be edited by other programs. Keep the tus offset fixed
    // at the original length so retries cannot write through the staging link.
    if (upload.size !== undefined && await this.isFinished(id)) {
      upload.offset = upload.size;
    }
    return upload;
  }

  async isPublishedAt(id: string, destination: string) {
    const [staged, existing] = await Promise.all([
      lstat(path.join(this.directory, id)),
      lstat(destination),
    ]);
    return existing.isFile() && staged.dev === existing.dev && staged.ino === existing.ino;
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
        if (!await this.isPublishedAt(id, destination)) {
          throw error;
        }
      } else if (crossDevice.some((code) => isFsError(error, code))) {
        // Preserve support for filesystems or nested mounts without hardlinks.
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        copied = true;
      } else {
        throw error;
      }
    }
    await this.markFinished(id, destination, copied);
  }

  /** Publish over an existing file. The rename swaps content atomically on the same filesystem. */
  async replace(id: string, destination: string) {
    if (await this.isFinished(id)) return;
    const source = path.join(this.directory, id);
    const temporary = path.join(this.directory, `${id}.replace`);
    try {
      await rm(temporary, { force: true });
      try {
        await link(source, temporary);
        await rename(temporary, destination);
      } catch (error) {
        if (!crossDevice.some((code) => isFsError(error, code))) throw error;
        // Nested mounts cannot rename between filesystems. Overwrite in place instead.
        await copyFile(source, destination);
      }
    } finally {
      await rm(temporary, { force: true });
    }
    // A failed marker leaves the replaced content in place; a retry replaces it again.
    await this.markFinished(id, destination, false);
  }

  private async markFinished(id: string, destination: string, removeOnFailure: boolean) {
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
