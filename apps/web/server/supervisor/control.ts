/**
 * Talk to the supervisor over its control socket, from inside the container:
 *
 *   bun server/supervisor/control.ts status
 *   bun server/supervisor/control.ts restart [release]
 *
 * `restart` replaces the running server with a fresh one, of `release` when named, without
 * closing the port. It waits until the new server is ready or the supervisor gives up on it,
 * which is at most the supervisor's readiness timeout, and says every few seconds what the new
 * server is doing meanwhile.
 */
import { HandoverStream, type HandoverEvent } from "./handover-stream";
import { defaultSocketPath } from "./settings";

const socket = process.env.NIMBUS_SUPERVISOR_SOCKET || defaultSocketPath;
const [command, release] = process.argv.slice(2);

const usage =
  "Usage: bun server/supervisor/control.ts status | restart [release]";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The supervisor's status, or null after saying why it could not be reached. */
async function reach(): Promise<Response | null> {
  try {
    return await fetch("http://supervisor/status", { unix: socket });
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
function describe(event: HandoverEvent, name: string | undefined) {
  switch (event.kind) {
    case "started":
      return `Restarting: the supervisor starts ${name ?? "the current release"} beside the running server, which keeps serving, and switches once the new one is ready, or gives up after ${event.readyTimeoutSeconds} seconds.`;
    case "progress":
      return event.starting
        ? `... still starting ${event.starting.release} (pid ${event.starting.pid}), ${event.seconds} s so far`
        : `... ${event.phase}, ${event.seconds} s so far`;
    case "done":
      return JSON.stringify(event.ok ? event.report : event.error, null, 2);
  }
}

async function restart(name: string | undefined) {
  // Reached first, so a failure later is never mistaken for a supervisor that is not there.
  if (!(await reach())) return 1;
  const started = Date.now();
  const cut = (why: string) => {
    console.error(
      `The supervisor at ${socket} took the restart, but the connection waiting for its answer ${why} after ${Math.round((Date.now() - started) / 1000)} seconds. The restart may still be going on: check with \`bun server/supervisor/control.ts status\`.`,
    );
    return 1;
  };
  try {
    const response = await fetch(
      `http://supervisor${name ? `/handover?release=${encodeURIComponent(name)}` : "/handover"}`,
      { method: "POST", unix: socket },
    );
    const done = await HandoverStream.read(response, (event) =>
      (event.kind === "done" && !event.ok ? console.error : console.info)(
        describe(event, name),
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
else {
  console.error(usage);
  process.exit(2);
}
