import type { ReadStream } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { DriveFile } from "@nimbus/api/drive-file";
import { ZipFile } from "yazl";
import type { ArchiveEntry } from "./routes/archive-entries";
import { streamBody } from "./file-response";

/**
 * Stream a ZIP of `entries` as a response body. Entries are stored without
 * compression: most large files are already compressed, and STORE runs at
 * disk speed (measured: 50,000 small files about five times faster than
 * archiver with a third of its memory). yazl writes ZIP64 records when sizes
 * or counts need them. Files are opened one at a time, when yazl reaches them.
 */
export function zipStream(
  entries: AsyncIterable<ArchiveEntry>,
  signal: AbortSignal | null,
  describe: string,
) {
  const zip = new ZipFile();
  // yazl's stream is a Node PassThrough; the declared type is the wider readable interface.
  const output =
    zip.outputStream instanceof PassThrough ? zip.outputStream : null;
  if (!output)
    throw new Error("yazl did not provide a Node PassThrough output stream.");
  let stopped = false;
  let active: ReadStream | null = null;
  // Client disconnects and cancelled downloads close the output. Stop walking and reading then.
  output.once("close", () => {
    stopped = true;
    active?.destroy();
  });
  signal?.addEventListener("abort", () => output.destroy(), { once: true });
  void (async () => {
    for await (const entry of entries) {
      if (stopped) return;
      if (entry.type === "dir") {
        zip.addEmptyDirectory(entry.name, { mtime: entry.mtime });
        continue;
      }
      zip.addReadStreamLazy(
        entry.name,
        { size: entry.size, mtime: entry.mtime, compress: false },
        (callback) => {
          // Listed as a plain file, but opened without following a symlink swapped in since.
          DriveFile.openFile(entry.absolute).then(
            ({ handle }) => {
              // 1 MiB reads: measured twice the throughput of the 64 KiB default.
              const stream = handle.createReadStream({
                highWaterMark: 1 << 20,
              });
              active = stream;
              stream.once("close", () => {
                if (active === stream) active = null;
              });
              callback(null, stream);
            },
            (error: unknown) =>
              // yazl fails the whole archive on an error and reads nothing from the stream.
              callback(
                error instanceof Error
                  ? error
                  : new Error(`Opening ${entry.name} for the ZIP failed.`),
                Readable.from([]),
              ),
          );
        },
      );
    }
    zip.end();
  })().catch((error: unknown) => {
    console.error(
      `ZIP download of ${describe} failed while reading the drive.`,
      error,
    );
    output.destroy(
      error instanceof Error ? error : new Error("ZIP generation failed."),
    );
  });
  return streamBody(output);
}
