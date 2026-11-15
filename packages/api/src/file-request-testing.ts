import type {
  FileRequest,
  FileRequestStore,
  FileRequestUpload,
} from "./file-request";

type Upload = FileRequestUpload & { finishedAt: number | null; name: string | null };

/** In-memory FileRequestStore with the same quota semantics as SQLite. */
export function createTestFileRequestStore(): FileRequestStore {
  const requests = new Map<string, FileRequest>();
  const uploads = new Map<string, Upload>();
  const counted = (requestId: string, activeSince: number) =>
    [...uploads.values()].filter(
      (upload) =>
        upload.requestId === requestId &&
        (upload.finishedAt !== null || upload.createdAt >= activeSince),
    );
  const usage = async (requestId: string, activeSince: number) => {
    const rows = counted(requestId, activeSince);
    return { files: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0) };
  };
  return {
    async create(request) { requests.set(request.id, request); },
    async getByToken(token) { return [...requests.values()].find((request) => request.token === token) ?? null; },
    async getById(id) { return requests.get(id) ?? null; },
    async list(userId) {
      return [...requests.values()].filter((request) => request.createdBy === userId).map((request) => {
        const finished = [...uploads.values()].filter((upload) => upload.requestId === request.id && upload.finishedAt !== null);
        return { ...request, received: { files: finished.length, bytes: finished.reduce((sum, row) => sum + row.size, 0) } };
      });
    },
    async update(id, userId, settings) {
      const request = requests.get(id);
      if (!request || request.createdBy !== userId) return null;
      const updated = { ...request, ...settings };
      requests.set(id, updated);
      return updated;
    },
    async revoke(id, userId) {
      if (requests.get(id)?.createdBy !== userId) return;
      requests.delete(id);
      for (const [key, upload] of uploads) if (upload.requestId === id) uploads.delete(key);
    },
    async reserve(upload, { activeSince, maxActive }) {
      const request = requests.get(upload.requestId);
      if (!request) return { kind: "unavailable" };
      const active = [...uploads.values()].filter((row) => row.requestId === request.id && row.finishedAt === null && row.createdAt >= activeSince);
      if (active.length >= maxActive) return { kind: "busy" };
      const used = await usage(request.id, activeSince);
      if (request.maxFiles !== null && used.files >= request.maxFiles) return { kind: "file-limit" };
      if (request.maxTotalBytes !== null && used.bytes + upload.size > request.maxTotalBytes) return { kind: "byte-limit" };
      uploads.set(upload.id, { ...upload, finishedAt: null, name: null });
      return { kind: "reserved" };
    },
    usage,
    async getUpload(id) {
      const upload = uploads.get(id);
      return upload ? { id: upload.id, requestId: upload.requestId, uploaderHash: upload.uploaderHash, size: upload.size, createdAt: upload.createdAt } : null;
    },
    async finishUpload(id, name, finishedAt) {
      const upload = uploads.get(id);
      if (upload && upload.finishedAt === null) uploads.set(id, { ...upload, name, finishedAt });
    },
    async releaseUpload(id) { if (uploads.get(id)?.finishedAt === null) uploads.delete(id); },
    async releaseAbandoned(cutoff) {
      for (const [key, upload] of uploads) if (upload.finishedAt === null && upload.createdAt < cutoff) uploads.delete(key);
    },
  };
}
