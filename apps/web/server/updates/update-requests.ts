import type { UpdateChannel } from "../supervisor/supervision";

/**
 * The server's way to its supervisor's updater, for the administration page: set at startup when
 * the server runs under the supervisor (start.ts), absent when it runs on its own, as in
 * development or the browser tests, which stub the page's requests instead.
 */
let channel: UpdateChannel | null = null;

export const UpdateRequests = {
  connect(supervisor: UpdateChannel) {
    channel = supervisor;
  },

  channel: () => channel,

  /** Why there is nothing to ask, when the server runs without its supervisor. */
  standalone:
    "Nimbus runs without its supervisor here (as with bun run dev), so it cannot update itself. Run it in its container, or under bun server/supervisor/main.ts.",
} as const;
