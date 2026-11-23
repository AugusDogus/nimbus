import sharp from "sharp";
import {
  finishThumbnail,
  THUMBNAIL_SIZE,
  ThumbnailTimeout,
  type ThumbnailRenderer,
} from "./thumbnails";

/** Hard bounds for one decoder process; inputs are untrusted user files. */
type Limits = {
  /** Wall-clock deadline before SIGKILL. */
  timeoutMs: number;
  /** Address-space limit (RLIMIT_AS). */
  memoryBytes: number;
  /** CPU-time limit (RLIMIT_CPU). */
  cpuSeconds: number;
  /** Output beyond this is treated as hostile and the process is killed. */
  maxOutputBytes: number;
};

/**
 * Run a decoder under prlimit with no stdin, discarded stderr and a capped
 * stdout. Resolves with stdout only on a clean exit.
 */
export async function runBounded(
  command: readonly string[],
  limits: Limits,
  signal: AbortSignal,
) {
  const child = Bun.spawn(
    [
      "prlimit",
      `--as=${limits.memoryBytes}`,
      `--cpu=${limits.cpuSeconds}`,
      "--core=0",
      "--nofile=64",
      `--fsize=0`,
      "--",
      ...command,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: limits.timeoutMs,
      killSignal: "SIGKILL",
      signal,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
  );
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = child.stdout.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > limits.maxOutputBytes) {
      child.kill("SIGKILL");
      await reader.cancel();
      break;
    }
    chunks.push(read.value);
  }
  const code = await child.exited;
  if (signal.aborted) throw signal.reason;
  // Killed at the wall-clock deadline, not for its output or CPU time (RLIMIT_CPU sends SIGXCPU).
  if (child.signalCode === "SIGKILL" && size <= limits.maxOutputBytes)
    throw new ThumbnailTimeout(
      `${command[0]} did not finish within ${limits.timeoutMs} ms.`,
    );
  if (code !== 0 || size > limits.maxOutputBytes)
    throw new Error(
      `${command[0]} exited with ${child.signalCode ?? `code ${code}`} after producing ${size} bytes.`,
    );
  return Buffer.concat(chunks);
}

/** First page via Poppler, scaled by Poppler itself so decoding stays small. */
export const pdfRenderer =
  (pdftoppm: string): ThumbnailRenderer =>
  async (absolute, signal) =>
    finishThumbnail(
      await runBounded(
        [
          pdftoppm,
          "-f",
          "1",
          "-l",
          "1",
          "-singlefile",
          "-scale-to",
          String(THUMBNAIL_SIZE),
          "-hide-annotations",
          "-png",
          absolute,
        ],
        {
          timeoutMs: 5_000,
          memoryBytes: 512 * 1024 * 1024,
          cpuSeconds: 3,
          maxOutputBytes: 4 * 1024 * 1024,
        },
        signal,
      ),
    );

const FRAME_BYTES = THUMBNAIL_SIZE * THUMBNAIL_SIZE * 4;

/**
 * One raw RGBA frame `seconds` into a video, through `filter`, from a single-threaded FFmpeg
 * that reads only local files of the container formats Nimbus decodes. Empty when the video has
 * no frame there. Output beyond `maxOutputBytes` fails the render.
 */
export const videoFrame = (
  ffmpeg: string,
  absolute: string,
  seconds: number,
  filter: string,
  maxOutputBytes: number,
  signal: AbortSignal,
) =>
  runBounded(
    [
      ffmpeg,
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-max_alloc",
      String(64 * 1024 * 1024),
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "mov,matroska,ogg",
      "-probesize",
      "1048576",
      "-analyzeduration",
      "1000000",
      "-max_probe_packets",
      "128",
      "-max_streams",
      "16",
      "-threads",
      "1",
      "-max_pixels",
      String(16_777_216),
      "-ss",
      String(seconds),
      "-i",
      `file:${absolute}`,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-frames:v",
      "1",
      "-filter_threads",
      "1",
      "-vf",
      filter,
      "-c:v",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    {
      timeoutMs: 8_000,
      memoryBytes: 1024 * 1024 * 1024,
      cpuSeconds: 5,
      maxOutputBytes,
    },
    signal,
  );

const frameAt = (
  ffmpeg: string,
  absolute: string,
  seconds: number,
  signal: AbortSignal,
) =>
  videoFrame(
    ffmpeg,
    absolute,
    seconds,
    // Transparent letterboxing keeps the output size fixed and exact.
    `scale=${THUMBNAIL_SIZE}:${THUMBNAIL_SIZE}:force_original_aspect_ratio=decrease,format=rgba,pad=${THUMBNAIL_SIZE}:${THUMBNAIL_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1`,
    FRAME_BYTES,
    signal,
  );

/** One frame near the start, decoded by a single-threaded, bounded FFmpeg. */
export const videoRenderer =
  (ffmpeg: string): ThumbnailRenderer =>
  async (absolute, signal) => {
    let frame = await frameAt(ffmpeg, absolute, 1, signal);
    // Clips shorter than a second have no frame at 1s.
    if (frame.byteLength !== FRAME_BYTES)
      frame = await frameAt(ffmpeg, absolute, 0, signal);
    if (frame.byteLength !== FRAME_BYTES)
      throw new Error(
        `FFmpeg produced ${frame.byteLength} bytes instead of one ${THUMBNAIL_SIZE}px frame.`,
      );
    return sharp(frame, {
      raw: { width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, channels: 4 },
    })
      .webp({ quality: 75 })
      .toBuffer();
  };
