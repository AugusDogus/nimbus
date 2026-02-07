import { FileStore } from "@tus/file-store";
import { Server } from "@tus/server";
import { mkdirSync } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { auth } from "@/lib/auth";
import { getDataRoot } from "@nimbus/api/data-root";
import { statPath } from "@nimbus/api/fs-utils";
import { resolveSafePath } from "@nimbus/api/safe-path";

const dataRoot = getDataRoot();
const uploadsDir = path.join(dataRoot, ".nimbus", "uploads");

// Ensure the uploads temp directory exists before the FileStore tries to use it.
mkdirSync(uploadsDir, { recursive: true });

const tusServer = new Server({
  path: "/api/upload",
  datastore: new FileStore({ directory: uploadsDir }),
  relativeLocation: true,

  // Auth: reject unauthenticated requests
  async onIncomingRequest(req) {
    // Extract cookies from the request headers for Better Auth
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) {
      throw { status_code: 401, body: "Unauthorized" };
    }
  },

  // Validate target path metadata when upload is created
  async onUploadCreate(_req, upload) {
    const targetPath = upload.metadata?.targetPath ?? "";

    // Validate path is safe (empty string = root, which is valid)
    try {
      resolveSafePath(targetPath);
    } catch {
      throw { status_code: 400, body: "Invalid target path." };
    }

    if (!upload.metadata?.filename) {
      throw { status_code: 400, body: "Missing filename metadata." };
    }

    return {};
  },

  // Move completed upload to final destination
  async onUploadFinish(_req, upload) {
    const targetPath = upload.metadata?.targetPath ?? "";
    const fileName = upload.metadata?.filename ?? upload.id;

    const dest = resolveSafePath(targetPath);

    // Ensure destination directory exists
    await mkdir(dest.absolute, { recursive: true });

    const sourcePath = path.join(uploadsDir, upload.id);
    let finalPath = path.join(dest.absolute, fileName);

    // Avoid silently overwriting existing files — add a suffix if needed
    finalPath = await deconflictPath(finalPath);

    await rename(sourcePath, finalPath);

    // Clean up the .json info file tus creates
    try {
      await unlink(`${sourcePath}.json`);
    } catch {
      // Info file may not exist, ignore
    }

    return {};
  },
});

/**
 * If a file already exists at `filePath`, appends " (1)", " (2)", etc.
 * before the extension until a free name is found. Mirrors the behavior
 * of Google Drive and macOS Finder.
 */
async function deconflictPath(filePath: string): Promise<string> {
  let candidate = filePath;
  let counter = 0;

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);

  while (true) {
    try {
      await statPath(candidate);
      // File exists — try next suffix
      counter++;
      candidate = path.join(dir, `${base} (${counter})${ext}`);
    } catch {
      // ENOENT — name is free
      return candidate;
    }
  }
}

const handler = tusServer.handleWeb.bind(tusServer);

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
