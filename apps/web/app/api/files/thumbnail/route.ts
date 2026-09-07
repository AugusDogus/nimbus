import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getDataRoot } from "@nimbus/api/data-root";
import { requireExisting, safePath } from "@nimbus/api/file-operations";
import { isFsError } from "@nimbus/api/safe-path";
import { httpError, requestAccess } from "@/server/http-files";

export async function GET(request: Request) {
  try {
    const access = await requestAccess(request);
    const target = await safePath(
      new URL(request.url).searchParams.get("path") ?? "",
    );
    access.require(target.relative, "read");
    const entry = await requireExisting(target.relative);
    if (
      !entry.stats.isFile() ||
      !/\.(png|jpe?g|webp|gif|avif)$/i.test(entry.relative)
    )
      return new Response(null, { status: 415 });
    const cache = path.join(getDataRoot(), ".nimbus", "cache", "thumbnails");
    const key = createHash("sha256")
      .update(`${entry.relative}:${entry.stats.mtimeMs}:${entry.stats.size}`)
      .digest("hex");
    const filename = path.join(cache, `${key}.webp`);
    let buffer: Uint8Array;
    try {
      buffer = await readFile(filename);
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error;
      buffer = await sharp(entry.absolute, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize(256, 256, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
      await mkdir(cache, { recursive: true });
      await writeFile(filename, buffer);
    }
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return httpError(error);
  }
}
