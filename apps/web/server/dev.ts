/**
 * `bun dev`: the Vite dev server for the browser app, and the Nimbus server, restarted when its
 * code changes. Open the Nimbus server's address; it loads pages and modules from Vite, whose
 * hot updates reach the browser over Vite's own socket.
 */
const vitePort = process.env.NIMBUS_VITE_PORT ?? "5173";
const env = {
  ...process.env,
  NODE_ENV: "development",
  NIMBUS_VITE_PORT: vitePort,
  NIMBUS_VITE_ORIGIN: `http://localhost:${vitePort}`,
};
const cwd = new URL("..", import.meta.url).pathname;
const children = [
  Bun.spawn(["bun", "--bun", "vite"], {
    cwd,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bun", "--watch", "server/start.ts"], {
    cwd,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }),
];
let stopping = false;
const stop = () => {
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// When either stops on its own, stop the other too and report its exit code.
const first = await Promise.race(children.map((child) => child.exited));
const failed = !stopping && first !== 0;
stop();
await Promise.all(children.map((child) => child.exited));
process.exit(failed ? first || 1 : 0);
