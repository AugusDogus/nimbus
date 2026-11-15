import type { Server } from "@tus/server";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getDataRoot } from "@nimbus/api/data-root";
import { httpError, requestAccess } from "@/server/http-files";
import { UploadStore } from "@/server/upload-store";
import { createUploadServer } from "../upload-server";

const tusFailureSchema = z.object({
  status_code: z.number().int().min(400).max(599),
  body: z.string(),
});
function tusFailure(error: unknown) {
  const failure = tusFailureSchema.safeParse(error);
  if (failure.success) return failure.data;
  const response = httpError(error);
  return {
    status_code: response.status,
    body:
      error instanceof Error ? error.message : "The upload failed. Try again.",
  };
}

let server: Server | undefined;

async function getServer() {
  if (server) return server;
  const uploadsDir = path.join(getDataRoot(), ".nimbus", "uploads");
  await mkdir(uploadsDir, { recursive: true });
  const store = new UploadStore({
    directory: uploadsDir,
    expirationPeriodInMilliseconds: 24 * 60 * 60 * 1000,
  });
  server = createUploadServer({ store, access: requestAccess, fail: tusFailure });
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
