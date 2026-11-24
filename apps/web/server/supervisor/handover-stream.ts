import { z } from "zod";
import type {
  HandoverError,
  HandoverReport,
  SupervisorStatus,
} from "./supervisor";

/**
 * The answer to `POST /handover` on the control socket: one JSON object per line, as the
 * handover goes. A handover lasts as long as the new server's startup, up to the readiness
 * timeout, and a connection with nothing on it is reset after Bun's idle timeout of 10 seconds,
 * which a Unix socket server cannot lift for one request; a line every few seconds keeps it
 * open, and tells whoever waits what is happening.
 *
 * - `started`: the handover was taken.
 * - `progress`: still under way, every `intervalMs`.
 * - `done`: its outcome, always the last line. A stream that ends without one was cut off, and
 *   says nothing about how the handover went.
 */
/** Why a handover, or an update that ends in one, did not happen. */
export type StreamError =
  | HandoverError
  /** An update failed before any handover: nothing was installed or started. */
  | { kind: "update-failed"; message: string };

export type HandoverEvent =
  | { kind: "started"; release: string | null; readyTimeoutSeconds: number }
  | {
      kind: "progress";
      seconds: number;
      phase: string;
      starting: { release: string; pid: number } | null;
    }
  | { kind: "done"; ok: true; report: HandoverReport }
  | { kind: "done"; ok: false; error: StreamError };

const event = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("started"),
    release: z.string().nullable(),
    readyTimeoutSeconds: z.number(),
  }),
  z.object({
    kind: z.literal("progress"),
    seconds: z.number(),
    phase: z.string(),
    starting: z.object({ release: z.string(), pid: z.number() }).nullable(),
  }),
  z.object({
    kind: z.literal("done"),
    ok: z.boolean(),
    report: z
      .object({
        from: z.string(),
        to: z.string(),
        readyMs: z.number(),
        draining: z
          .object({ pid: z.number(), deadline: z.string() })
          .nullable(),
        fullRestart: z.string().nullable(),
      })
      .optional(),
    error: z
      .object({
        kind: z.enum(["busy", "unknown-release", "not-ready", "update-failed"]),
        message: z.string(),
      })
      .optional(),
  }),
]);

/** A parsed line, or null for one that is not an event. */
function parse(line: string): HandoverEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = event.safeParse(value);
  if (!parsed.success) return null;
  const read = parsed.data;
  if (read.kind !== "done") return read;
  if (read.ok && read.report)
    return { kind: "done", ok: true, report: read.report };
  if (!read.ok && read.error)
    return { kind: "done", ok: false, error: read.error };
  return null;
}

export const HandoverStream = {
  /** Stream `outcome` as it settles, with progress from `status` meanwhile. */
  respond(
    release: string | null,
    outcome: Promise<
      { ok: true; value: HandoverReport } | { ok: false; error: StreamError }
    >,
    {
      status,
      readyTimeoutSeconds,
      intervalMs = 5_000,
    }: {
      status: () => SupervisorStatus;
      readyTimeoutSeconds: number;
      intervalMs?: number;
    },
  ): Response {
    const encoder = new TextEncoder();
    const started = Date.now();
    const line = (value: HandoverEvent) =>
      encoder.encode(`${JSON.stringify(value)}\n`);
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          line({ kind: "started", release, readyTimeoutSeconds }),
        );
        timer = setInterval(() => {
          const now = status();
          controller.enqueue(
            line({
              kind: "progress",
              seconds: Math.round((Date.now() - started) / 1000),
              phase: now.phase,
              starting: now.starting
                ? { release: now.starting.release, pid: now.starting.pid }
                : null,
            }),
          );
        }, intervalMs);
        void outcome.then((settled) => {
          clearInterval(timer);
          controller.enqueue(
            line(
              settled.ok
                ? { kind: "done", ok: true, report: settled.value }
                : { kind: "done", ok: false, error: settled.error },
            ),
          );
          controller.close();
        });
      },
      cancel() {
        // Whoever waited went away; the handover itself goes on.
        clearInterval(timer);
      },
    });
    return new Response(body, {
      // A connection of its own, closed after the outcome (see ControlClient).
      headers: { "Content-Type": "application/x-ndjson", Connection: "close" },
    });
  },

  /**
   * Read a handover's answer, passing every event to `onEvent`: the `done` event, or null when
   * the stream ended without one.
   */
  async read(
    response: Response,
    onEvent: (event: HandoverEvent) => void = () => undefined,
  ): Promise<Extract<HandoverEvent, { kind: "done" }> | null> {
    if (!response.body) return null;
    const decoder = new TextDecoder();
    let buffered = "";
    let done: Extract<HandoverEvent, { kind: "done" }> | null = null;
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const text of lines) {
        const read = parse(text);
        if (!read) continue;
        onEvent(read);
        if (read.kind === "done") done = read;
      }
    }
    return done;
  },
} as const;
