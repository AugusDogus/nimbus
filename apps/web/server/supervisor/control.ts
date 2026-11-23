/**
 * Talk to the supervisor over its control socket, from inside the container:
 *
 *   bun server/supervisor/control.ts status
 *   bun server/supervisor/control.ts restart [release]
 *
 * `restart` replaces the running server with a fresh one, of `release` when named, without
 * closing the port; it answers once the new server listens.
 */
import { defaultSocketPath } from "./settings";

const socket = process.env.NIMBUS_SUPERVISOR_SOCKET || defaultSocketPath;
const [command, release] = process.argv.slice(2);

const usage =
  "Usage: bun server/supervisor/control.ts status | restart [release]";

async function call(pathname: string, method: "GET" | "POST") {
  try {
    const response = await fetch(`http://supervisor${pathname}`, {
      method,
      unix: socket,
    });
    console.info(JSON.stringify(await response.json(), null, 2));
    return response.ok ? 0 : 1;
  } catch (error) {
    console.error(
      `Could not reach the supervisor at ${socket} (${error instanceof Error ? error.message : String(error)}). Run this inside the Nimbus container, as root or the user Nimbus runs as.`,
    );
    return 1;
  }
}

if (command === "status") process.exit(await call("/status", "GET"));
else if (command === "restart")
  process.exit(
    await call(
      release
        ? `/handover?release=${encodeURIComponent(release)}`
        : "/handover",
      "POST",
    ),
  );
else {
  console.error(usage);
  process.exit(2);
}
