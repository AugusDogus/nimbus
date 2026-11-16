import type { Server } from "@tus/server";
import { httpDriveStore, httpError, requestAccess } from "@/server/http-files";
import { tusFailure } from "@/server/tus-failure";
import { uploadStaging } from "@/server/upload-publish";
import { createUploadServer } from "../upload-server";

let server: Server | undefined;

async function getServer() {
  if (server) return server;
  server = createUploadServer({
    store: await uploadStaging(),
    versions: httpDriveStore.versions,
    access: requestAccess,
    fail: tusFailure,
  });
  return server;
}

async function handler(request: Request) {
  try {
    return await (await getServer()).handleWeb(request);
  } catch (error) {
    return httpError(error);
  }
}
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
