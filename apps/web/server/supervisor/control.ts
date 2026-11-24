/**
 * Talk to the supervisor over its control socket, from inside the container:
 *
 *   bun server/supervisor/control.ts status
 *   bun server/supervisor/control.ts restart [release]
 *   bun server/supervisor/control.ts update status | check | install | rollback
 *
 * `restart` replaces the running server with a fresh one, of `release` when named, without
 * closing the port. It waits until the new server is ready or the supervisor gives up on it,
 * which is at most the supervisor's readiness timeout, and says every few seconds what the new
 * server is doing meanwhile.
 */
import { ControlClient } from "./control-client";
import type { HandoverEvent } from "./handover-stream";
import { defaultSocketPath } from "./settings";

const socket = process.env.NIMBUS_SUPERVISOR_SOCKET || defaultSocketPath;
const [command, release] = process.argv.slice(2);

const usage =
  "Usage: bun server/supervisor/control.ts status | restart [release] | update status|check|install|rollback";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The supervisor's status, or null after saying why it could not be reached. */
async function reach(): Promise<Response | null> {
  try {
    return await ControlClient.status(socket);
  } catch (error) {
    console.error(
      `Could not reach the supervisor at ${socket} (${message(error)}). Run this inside the Nimbus container, as root or the user Nimbus runs as.`,
    );
    return null;
  }
}

async function status() {
  const response = await reach();
  if (!response) return 1;
  console.info(JSON.stringify(await response.json(), null, 2));
  return response.ok ? 0 : 1;
}

/** What a handover's event says, for a person watching. */
function describe(
  event: HandoverEvent,
  what: "restart" | "update" | "rollback",
  name: string | undefined,
) {
  switch (event.kind) {
    case "started":
      return what === "update"
        ? `Updating: the supervisor downloads and verifies the release the last check offered, then starts it beside the running server, which keeps serving, and switches once it is ready, or gives up after ${event.readyTimeoutSeconds} seconds.`
        : what === "rollback"
          ? `Rolling back: the supervisor starts the release that ran before beside the running server, and switches once it is ready, or gives up after ${event.readyTimeoutSeconds} seconds.`
          : `Restarting: the supervisor starts ${name ?? "the current release"} beside the running server, which keeps serving, and switches once the new one is ready, or gives up after ${event.readyTimeoutSeconds} seconds.`;
    case "progress":
      return event.starting
        ? `... still starting ${event.starting.release} (pid ${event.starting.pid}), ${event.seconds} s so far`
        : `... ${event.phase}, ${event.seconds} s so far`;
    case "done":
      return JSON.stringify(event.ok ? event.report : event.error, null, 2);
  }
}

/** Print a JSON answer; 0 when it was a success. */
async function printed(response: Response | null) {
  if (!response) return 1;
  console.info(JSON.stringify(await response.json(), null, 2));
  return response.ok ? 0 : 1;
}

async function update(action: string | undefined) {
  if (!(await reach())) return 1;
  switch (action) {
    case "status":
      return printed(await ControlClient.updateStatus(socket));
    case "check":
      return printed(await ControlClient.checkForUpdate(socket));
    case "install":
    case "rollback":
      return streamed(
        (onEvent) => ControlClient.update(socket, action, onEvent),
        {
          what: action === "install" ? "update" : "rollback",
          name: undefined,
        },
      );
    default:
      console.error(usage);
      return 2;
  }
}

async function restart(name: string | undefined) {
  // Reached first, so a failure later is never mistaken for a supervisor that is not there.
  if (!(await reach())) return 1;
  return streamed(
    (onEvent) => ControlClient.handover(socket, name ?? null, onEvent),
    { what: "restart", name },
  );
}

/** Follow a streamed answer, saying what happens; 0 once it succeeded. */
async function streamed(
  run: (
    onEvent: (event: HandoverEvent) => void,
  ) => ReturnType<typeof ControlClient.handover>,
  {
    what,
    name,
  }: { what: "restart" | "update" | "rollback"; name: string | undefined },
) {
  const started = Date.now();
  const cut = (why: string) => {
    console.error(
      `The supervisor at ${socket} took the ${what}, but the connection waiting for its answer ${why} after ${Math.round((Date.now() - started) / 1000)} seconds. The ${what} may still be going on: check with \`bun server/supervisor/control.ts status\`.`,
    );
    return 1;
  };
  try {
    const done = await run((event) =>
      (event.kind === "done" && !event.ok ? console.error : console.info)(
        describe(event, what, name),
      ),
    );
    if (!done) return cut("ended without its outcome");
    return done.ok ? 0 : 1;
  } catch (error) {
    return cut(`closed (${message(error)})`);
  }
}

if (command === "status") process.exit(await status());
else if (command === "restart") process.exit(await restart(release));
else if (command === "update") process.exit(await update(release));
else {
  console.error(usage);
  process.exit(2);
}
