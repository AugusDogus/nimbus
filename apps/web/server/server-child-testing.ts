import type { Subprocess } from "bun";
import { fileURLToPath } from "node:url";

/**
 * The real server, started from start.ts in a child process for a test. Every failure while it
 * runs, from a timeout to an `expect`, is reported with how the server ended and everything it
 * printed, so a failure on CI names its own cause instead of needing a rerun.
 */
const startScript = fileURLToPath(new URL("./start.ts", import.meta.url));
const waitMs = 30_000;

type Exit = { exitCode: number | null; signalCode: string | number | null };

/** How a child ended, or that it still runs: "exited with code 1", "was stopped by SIGKILL". */
const exitOf = (child: Exit) =>
  child.signalCode !== null
    ? `was stopped by ${child.signalCode}`
    : child.exitCode !== null
      ? `exited with code ${child.exitCode}`
      : "was still running";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Everything `child` prints to stdout and stderr, in the order it arrives. */
function collect(child: Subprocess<"ignore", "pipe", "pipe">) {
  let text = "";
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream)
      text += decoder.decode(chunk, { stream: true });
  };
  const done = Promise.all([read(child.stdout), read(child.stderr)]);
  return { text: () => text, done };
}

/** The port in the server's ready line, once it has printed it. */
const readyPort = (output: string) => {
  const port = /Nimbus is ready at http:\/\/localhost:(\d+)/.exec(output)?.[1];
  return port === undefined ? null : Number(port);
};

export type RunningServer = {
  /** Where the server listens, such as http://localhost:40123: the free port it was given. */
  url: string;
  /** Everything the server printed so far. */
  output: () => string;
  /** Whether the server process still runs. */
  running: () => boolean;
  /** Wait for `check`; fails after 30 seconds, or at once if the server stops. */
  until: (
    check: () => Promise<boolean> | boolean,
    what: string,
  ) => Promise<void>;
};

export const ServerChild = {
  exitOf,

  /**
   * Start the server with `env` on a free port the kernel picks (PORT=0), so no other socket
   * can hold it, wait until it is ready, run `body`, then stop it with SIGTERM, which must end
   * it cleanly. `wrap` runs the server through another command, such as `unshare`, which must
   * exec it. `env` must set BETTER_AUTH_URL: the port is not known before it starts.
   */
  async run(
    options: {
      cwd: string;
      env: Record<string, string>;
      wrap?: readonly string[];
    },
    body: (server: RunningServer) => Promise<void>,
  ): Promise<void> {
    const child = Bun.spawn(
      [...(options.wrap ?? []), process.execPath, startScript],
      {
        cwd: options.cwd,
        env: { ...options.env, PORT: "0" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = collect(child);
    const running = () => child.exitCode === null && child.signalCode === null;
    const poll = async <T>(
      check: () => Promise<T | null> | T | null,
      what: string,
    ): Promise<T> => {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const value = await check();
        if (value !== null) return value;
        if (!running())
          throw new Error(`The server stopped while waiting: ${what}.`);
        if (Date.now() > deadline)
          throw new Error(
            `Timed out after ${waitMs / 1000} s waiting: ${what}.`,
          );
        await Bun.sleep(100);
      }
    };
    let failure: { error: unknown; state: string } | null = null;
    try {
      const port = await poll(
        () => readyPort(output.text()),
        "the server to report it is ready",
      );
      await body({
        url: `http://localhost:${port}`,
        output: output.text,
        running,
        until: async (check, what) => {
          await poll(async () => ((await check()) ? true : null), what);
        },
      });
    } catch (error) {
      failure = { error, state: exitOf(child) };
    }
    child.kill("SIGTERM");
    await child.exited;
    // A process that inherited the pipes could hold them open; the server's own output is in.
    await Promise.race([output.done, Bun.sleep(1000)]);
    const printed = output.text() || "(nothing)\n";
    if (failure !== null)
      throw new Error(
        `${messageOf(failure.error)}\n\nWhen this failed, the server ${failure.state}; after SIGTERM it ${exitOf(child)}. Its output:\n${printed}`,
        { cause: failure.error },
      );
    if (child.exitCode !== 0)
      throw new Error(
        `The server did not shut down cleanly on SIGTERM: it ${exitOf(child)}. Its output:\n${printed}`,
      );
  },

  /**
   * Start the server with `env` and wait for it to exit on its own, as it must when startup
   * fails. It is killed after 20 seconds. The result reads whole in a failed assertion.
   */
  async exit(options: { cwd: string; env: Record<string, string> }) {
    const child = Bun.spawn([process.execPath, startScript], {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = collect(child);
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    await child.exited;
    clearTimeout(timer);
    await Promise.race([output.done, Bun.sleep(1000)]);
    return { exit: exitOf(child), output: output.text() };
  },
} as const;
