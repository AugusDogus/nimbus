import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  anonymousActor,
  flushAudit,
  markAuditImpersonator,
  recordAudit,
  resetAuditForTest,
  runWithAuditRequest,
  setAuditSink,
  type RecordedAuditEvent,
} from "./audit";

beforeEach(resetAuditForTest);
afterEach(resetAuditForTest);

const event = { action: "share.created", actor: { type: "system" } } as const;

it("keeps events recorded before a sink is installed and writes them in order", async () => {
  recordAudit(event);
  recordAudit({ ...event, action: "share.revoked" });
  const written: RecordedAuditEvent[] = [];
  setAuditSink(async (events) => void written.push(...events));
  await flushAudit();
  expect(written.map((entry) => entry.action)).toEqual([
    "share.created",
    "share.revoked",
  ]);
  expect(written[0]?.at).toBeNumber();
});

it("returns to the caller before the sink finishes writing", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  setAuditSink(() => gate);
  const started = performance.now();
  recordAudit(event);
  expect(performance.now() - started).toBeLessThan(5);
  const flushed = flushAudit();
  release();
  await flushed;
});

it("requeues a failed batch instead of losing it", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    setAuditSink(async () => {
      throw new Error("disk full");
    });
    recordAudit(event);
    await flushAudit();
    const written: RecordedAuditEvent[] = [];
    setAuditSink(async (events) => void written.push(...events));
    await flushAudit();
    expect(written).toHaveLength(1);
  } finally {
    console.error = original;
  }
});

it("attaches the client address of the surrounding request", async () => {
  const written: RecordedAuditEvent[] = [];
  setAuditSink(async (events) => void written.push(...events));
  await runWithAuditRequest(
    { ip: "198.51.100.7", userAgent: "Test" },
    async () => {
      await Promise.resolve();
      recordAudit(event);
    },
  );
  recordAudit(event);
  await flushAudit();
  expect(written.map((entry) => entry.ip)).toEqual(["198.51.100.7", undefined]);
});

it("labels an anonymous caller only with a well-formed email address", () => {
  expect(anonymousActor("Someone@Example.test")).toEqual({
    type: "anonymous",
    label: "someone@example.test",
  });
  expect(anonymousActor("MySecretPassw0rd!")).toEqual({ type: "anonymous" });
  expect(anonymousActor("")).toEqual({ type: "anonymous" });
  expect(anonymousActor(undefined)).toEqual({ type: "anonymous" });
});

it("marks every event of a request made in an impersonated session with the administrator", async () => {
  const written: RecordedAuditEvent[] = [];
  setAuditSink(async (events) => void written.push(...events));
  runWithAuditRequest({ ip: "192.0.2.1" }, () => {
    recordAudit({ ...event, details: { kept: true } });
    markAuditImpersonator({ id: "admin-1", label: "admin@example.test" });
    recordAudit({ ...event, details: { kept: true } });
  });
  recordAudit(event);
  await flushAudit();
  expect(written.map((entry) => entry.details)).toEqual([
    { kept: true },
    {
      kept: true,
      impersonatedBy: "admin@example.test",
      impersonatedById: "admin-1",
    },
    undefined,
  ]);
});
