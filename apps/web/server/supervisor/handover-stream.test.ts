import { expect, test } from "bun:test";
import { HandoverStream, type HandoverEvent } from "./handover-stream";
import type { SupervisorStatus } from "./supervisor";

const status = (): SupervisorStatus => ({
  run: { id: "run-0123456789abcdef", startedAt: 1 },
  phase: "handing-over",
  active: { release: "old", pid: 10, since: "2026-01-01T00:00:00.000Z" },
  starting: { release: "next", pid: 11, since: "2026-01-01T00:00:01.000Z" },
  draining: [],
  recovering: [],
});

const report = {
  from: "old",
  to: "next",
  readyMs: 120,
  draining: { pid: 10, deadline: "2026-01-01T06:00:00.000Z" },
  fullRestart: null,
};

test("a handover's answer reports progress while it lasts, then its outcome", async () => {
  const outcome = Bun.sleep(130).then(() => ({
    ok: true as const,
    value: report,
  }));
  const response = HandoverStream.respond("next", outcome, {
    status,
    readyTimeoutSeconds: 300,
    intervalMs: 30,
  });
  const seen: HandoverEvent["kind"][] = [];
  const done = await HandoverStream.read(response, (event) => {
    seen.push(event.kind);
  });
  expect(done).toEqual({ kind: "done", ok: true, report });
  expect(seen[0]).toBe("started");
  expect(
    seen.filter((kind) => kind === "progress").length,
  ).toBeGreaterThanOrEqual(2);
  expect(seen.at(-1)).toBe("done");
});

test("a refused handover ends with its reason", async () => {
  const error = {
    kind: "busy" as const,
    message: "A handover is already under way.",
  };
  const done = await HandoverStream.read(
    HandoverStream.respond(
      null,
      Promise.resolve({ ok: false as const, error }),
      {
        status,
        readyTimeoutSeconds: 300,
      },
    ),
  );
  expect(done).toEqual({ kind: "done", ok: false, error });
});

test("an answer cut off before its outcome says nothing about the handover", async () => {
  const cut = new Response(
    `${JSON.stringify({ kind: "started", release: null, readyTimeoutSeconds: 300 })}\n{"kind":"pro`,
  );
  expect(await HandoverStream.read(cut)).toBeNull();
});
