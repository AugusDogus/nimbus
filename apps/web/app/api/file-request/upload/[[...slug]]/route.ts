import { RateLimiter } from "@/server/rate-limit";
import { EVENTS, Server } from "@tus/server";
import { TRPCError } from "@trpc/server";
import { getDataRoot } from "@nimbus/api/data-root";
import { fileNameSchema } from "@nimbus/api/file-name";
import {
  fileRequestMaxBytes,
  reservationLifetimeMs,
} from "@nimbus/api/file-request";
import { mutateFiles } from "@nimbus/api/file-mutations";
import { FilesystemCapacity } from "@nimbus/api/filesystem-capacity";
import {
  activeFileRequest,
  FileRequestLimits,
  isFileRequestUnlocked,
  Uploader,
  uploaderAddress,
} from "@/server/file-request-access";
import { httpDriveStore, httpError } from "@/server/http-files";
import { tusFailure } from "@/server/tus-failure";
import {
  createUploadFinisher,
  publishUpload,
  uploadStaging,
} from "@/server/upload-publish";

const fail = (status_code: number, body: string) => ({ status_code, body });
const locked = () => fail(401, "Enter this link's password before uploading.");

/**
 * Anonymous tus endpoint for file requests. It shares the signed-in upload
 * staging store and publish step; only authorization differs. Each upload is
 * bound to its uploader's browser, and uploaders can never read anything back.
 */
let server: Server | undefined;

async function reservedUpload(request: Request, id: string) {
  if (!/^[a-f0-9]{32}$/.test(id))
    throw fail(
      400,
      "This upload identifier is invalid. Start the upload again.",
    );
  const upload = await httpDriveStore.fileRequests.getUpload(id);
  // Uploads of other browsers are indistinguishable from missing ones.
  if (!upload || upload.uploaderHash !== Uploader.hash(request))
    throw fail(404, "This upload expired or was cancelled. Start it again.");
  const active = await activeFileRequest({ id: upload.requestId });
  if (!isFileRequestUnlocked(active.request, request)) throw locked();
  return { upload, ...active };
}

async function getServer() {
  if (server) return server;
  const store = await uploadStaging();
  const finisher = createUploadFinisher(store);
  /** Publish once, however many requests race to finish the same upload. */
  const publish = (
    request: Request,
    id: string,
    filename: string | null | undefined,
  ) =>
    finisher.finish(id, async () => {
      const { request: fileRequest } = await reservedUpload(request, id);
      await mutateFiles([], { userId: fileRequest.createdBy }, async () => {
        // Re-check inside the queue: the owner may have lost access meanwhile.
        const { request: current, owner } = await activeFileRequest({
          id: fileRequest.id,
        });
        const result = await publishUpload({
          store,
          uploadId: id,
          filename: fileNameSchema.parse(filename),
          folder: current.path,
          conflict: { kind: "keep-both" },
          credentials: { userId: owner.user.id },
          requireWrite: (relative) => {
            if (!owner.can(relative, "write"))
              throw new TRPCError({
                code: "NOT_FOUND",
                message: "This upload link is no longer available.",
              });
          },
        });
        if (result.kind === "published")
          await httpDriveStore.fileRequests.finishUpload(
            id,
            result.path,
            Date.now(),
          );
      });
    });
  server = new Server({
    path: "/api/file-request/upload",
    datastore: store,
    relativeLocation: true,
    maxSize: fileRequestMaxBytes,
    async onIncomingRequest(request, id) {
      if (request.method === "POST" || request.method === "OPTIONS") return;
      try {
        await reservedUpload(request, id);
        await finisher.recover(request, id, (metadata) =>
          publish(request, id, metadata?.filename),
        );
      } catch (error) {
        throw tusFailure(error);
      }
    },
    async onUploadCreate(request, upload) {
      try {
        const uploaderHash = Uploader.hash(request);
        if (!uploaderHash)
          throw fail(401, "Reload the upload page, then add the file again.");
        const token = upload.metadata?.request ?? "";
        const { request: fileRequest } = await activeFileRequest({ token });
        if (!isFileRequestUnlocked(fileRequest, request)) throw locked();
        const client = uploaderAddress(request);
        for (const decision of [
          FileRequestLimits.uploadsPerClientAndLink.consume(
            `${client} ${fileRequest.id}`,
          ),
          FileRequestLimits.uploadsPerClient.consume(client),
          FileRequestLimits.uploadsPerLink.consume(fileRequest.id),
        ])
          if (!decision.allowed)
            throw fail(
              429,
              `Too many uploads right now. Try again in ${RateLimiter.seconds(decision.retryAfterSeconds)}.`,
            );
        const name = fileNameSchema.safeParse(upload.metadata?.filename);
        if (!name.success)
          throw fail(
            400,
            "Rename the file without slashes or reserved names, then upload it again.",
          );
        // Quotas are reserved up front, so the size must be declared now.
        if (upload.size === undefined)
          throw fail(400, "Declare the file size when starting the upload.");
        if (
          fileRequest.maxFileBytes !== null &&
          upload.size > fileRequest.maxFileBytes
        )
          throw fail(413, "This file is larger than the link allows.");
        const capacity = await FilesystemCapacity.read(getDataRoot());
        if (
          capacity &&
          capacity.availableBytes - upload.size <
            FileRequestLimits.minimumFreeBytes(capacity.totalBytes)
        )
          throw fail(
            507,
            "The server does not have enough free space for this file. Tell the person who sent the link.",
          );
        const now = Date.now();
        const reservation = await httpDriveStore.fileRequests.reserve(
          {
            id: upload.id,
            requestId: fileRequest.id,
            uploaderHash,
            size: upload.size,
            createdAt: now,
          },
          {
            activeSince: now - reservationLifetimeMs,
            maxActive: FileRequestLimits.maxActiveUploads,
          },
        );
        if (reservation.kind === "file-limit")
          throw fail(413, "This link has received all the files it accepts.");
        if (reservation.kind === "byte-limit")
          throw fail(
            413,
            "This file would exceed the total size the link accepts.",
          );
        if (reservation.kind === "busy")
          throw fail(
            429,
            "Too many uploads are in progress on this link. Wait for some to finish, then try again.",
          );
        if (reservation.kind === "unavailable")
          throw fail(404, "This upload link has expired or been revoked.");
        return { metadata: { filename: name.data, request: fileRequest.id } };
      } catch (error) {
        throw tusFailure(error);
      }
    },
    async onUploadFinish(request, upload) {
      try {
        await publish(request, upload.id, upload.metadata?.filename);
      } catch (error) {
        throw tusFailure(error);
      }
      return {};
    },
  });
  server.on(EVENTS.POST_TERMINATE, (_request, _response, id) => {
    void httpDriveStore.fileRequests
      .releaseUpload(id)
      .catch((error: unknown) =>
        console.error(
          `Nimbus could not release the quota of cancelled file request upload ${id}. It lapses within a day.`,
          error,
        ),
      );
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
