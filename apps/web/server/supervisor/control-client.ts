import { HandoverStream, type HandoverEvent } from "./handover-stream";

/**
 * The supervisor's control socket, from a client: `bun server/supervisor/control.ts`, the
 * tests and the handover harness all ask through this.
 *
 * Every request goes on a connection of its own, and every answer closes its connection
 * (`Connection: close`, see main.ts). Bun's fetch would otherwise keep a finished connection
 * pooled and send the next request on it, also as the server closes it for idleness, which
 * resets that request: a `status` right after a `restart` would then fail although the
 * supervisor is fine.
 */
const ask = (socket: string, pathname: string, method: "GET" | "POST") =>
  fetch(`http://supervisor${pathname}`, {
    method,
    unix: socket,
    keepalive: false,
  });

export const ControlClient = {
  /** `GET /status`; rejects when the socket cannot be reached. */
  status: (socket: string) => ask(socket, "/status", "GET"),

  /**
   * `POST /handover`, to `release` or the current one, passing each event to `onEvent`: the
   * outcome, or null when the answer ended without one. Rejects when the connection fails.
   */
  async handover(
    socket: string,
    release: string | null,
    onEvent: (event: HandoverEvent) => void = () => undefined,
  ) {
    const response = await ask(
      socket,
      release === null
        ? "/handover"
        : `/handover?release=${encodeURIComponent(release)}`,
      "POST",
    );
    return HandoverStream.read(response, onEvent);
  },

  /** `GET /update`: the update status. */
  updateStatus: (socket: string) => ask(socket, "/update", "GET"),

  /** `POST /update/check`: ask the update source now. */
  checkForUpdate: (socket: string) => ask(socket, "/update/check", "POST"),

  /**
   * `POST /update/install` or `/update/rollback`, streamed as a handover is: the outcome, or null
   * when the answer ended without one.
   */
  async update(
    socket: string,
    action: "install" | "rollback",
    onEvent: (event: HandoverEvent) => void = () => undefined,
  ) {
    return HandoverStream.read(
      await ask(socket, `/update/${action}`, "POST"),
      onEvent,
    );
  },
} as const;
