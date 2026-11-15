import { z } from "zod";

/**
 * A file request is a public upload link: visitors without an account can add
 * files to one folder and nothing else. They cannot list, read, overwrite or
 * delete anything, including what they uploaded.
 */
export type FileRequest = {
  id: string;
  token: string;
  path: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  passwordHash: string | null;
  note: string | null;
  maxFileBytes: number | null;
  maxFiles: number | null;
  maxTotalBytes: number | null;
};

export type FileRequestSettings = Pick<
  FileRequest,
  | "expiresAt"
  | "passwordHash"
  | "note"
  | "maxFileBytes"
  | "maxFiles"
  | "maxTotalBytes"
>;

export type FileRequestUsage = { files: number; bytes: number };

/** `received` counts finished uploads only. */
export type FileRequestSummary = FileRequest & {
  received: FileRequestUsage;
};

export type FileRequestUpload = {
  id: string;
  requestId: string;
  size: number;
  createdAt: number;
};

export type Reservation =
  | { kind: "reserved" }
  | { kind: "file-limit" }
  | { kind: "byte-limit" }
  | { kind: "busy" }
  | { kind: "unavailable" };

export type FileRequestStore = {
  create(request: FileRequest): Promise<void>;
  getByToken(token: string): Promise<FileRequest | null>;
  list(userId: string): Promise<FileRequestSummary[]>;
  update(
    id: string,
    userId: string,
    settings: FileRequestSettings,
  ): Promise<FileRequest | null>;
  revoke(id: string, userId: string): Promise<void>;
  /**
   * Atomically reserve quota for one upload of `size` bytes. Unfinished uploads
   * created before `activeSince` are abandoned and no longer hold quota.
   */
  reserve(
    upload: FileRequestUpload,
    options: { activeSince: number; maxActive: number },
  ): Promise<Reservation>;
  /** Finished uploads plus reservations of uploads active since `activeSince`. */
  usage(requestId: string, activeSince: number): Promise<FileRequestUsage>;
  getUpload(id: string): Promise<FileRequestUpload | null>;
  finishUpload(id: string, name: string, finishedAt: number): Promise<void>;
  /** Forget unfinished reservations created before `cutoff`. */
  releaseAbandoned(cutoff: number): Promise<void>;
};

/** Staged tus uploads expire after a day; their reservations end with them. */
export const reservationLifetimeMs = 24 * 60 * 60 * 1000;
/** Largest single upload when the owner sets no lower limit (1 TiB). */
export const fileRequestMaxBytes = 2 ** 40;

const optionalLimit = (max: number) =>
  z.number().int().min(1).max(max).nullable();

export const fileRequestLimitsSchema = z.object({
  expiresAt: z.number().int().nullable(),
  note: z.string().trim().max(1000).nullable(),
  maxFileBytes: optionalLimit(fileRequestMaxBytes),
  maxFiles: optionalLimit(100_000),
  maxTotalBytes: optionalLimit(2 ** 50),
});

function availability(request: Pick<FileRequest, "expiresAt">, now: number) {
  return request.expiresAt !== null && request.expiresAt <= now
    ? ({ kind: "expired" } as const)
    : ({ kind: "available" } as const);
}

/** The per-file ceiling an uploader may declare, after every configured limit. */
function maxUploadBytes(
  request: Pick<FileRequest, "maxFileBytes" | "maxTotalBytes">,
  received: FileRequestUsage,
) {
  return Math.max(
    0,
    Math.min(
      request.maxFileBytes ?? fileRequestMaxBytes,
      request.maxTotalBytes === null
        ? fileRequestMaxBytes
        : request.maxTotalBytes - received.bytes,
    ),
  );
}

export const FileRequest = { availability, maxUploadBytes } as const;
