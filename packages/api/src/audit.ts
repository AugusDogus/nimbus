import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Security audit trail. Call `recordAudit` after an action succeeds (or, for failures
 * such as rejected sign-ins, when it is refused). Recording never throws and never
 * waits for storage: events are queued and written in batches by the sink that the
 * server installs at startup, keeping writes off request hot paths.
 */
export const auditActions = [
  "auth.sign_in",
  "auth.sign_in_failed",
  "auth.rate_limited",
  "auth.password_changed",
  "auth.password_reset_requested",
  "auth.password_reset",
  "auth.two_factor_enabled",
  "auth.two_factor_disabled",
  "auth.recovery_codes_regenerated",
  "auth.passkey_added",
  "auth.passkey_removed",
  "auth.session_revoked",
  "auth.sessions_revoked",
  "account.created",
  "account.updated",
  "account.role_changed",
  "account.disabled",
  "account.enabled",
  "account.removed",
  "account.password_set",
  "account.second_factors_reset",
  "account.sessions_revoked",
  "group.saved",
  "group.removed",
  "grant.added",
  "grant.removed",
  "share.created",
  "share.revoked",
  "share.password_failed",
  "trash.moved",
  "trash.restored",
  "trash.purged",
  "trash.expired",
  "app_password.created",
  "app_password.revoked",
  "webdav.auth_failed",
] as const;
export type AuditAction = (typeof auditActions)[number];

export type AuditActor =
  | { type: "user"; id: string; label: string }
  | { type: "anonymous"; label?: string }
  | { type: "system" };

export type AuditTarget = {
  type: "user" | "group" | "path" | "share" | "session" | "app_password" | "passkey";
  id: string;
  label?: string;
};

export type AuditDetails = Record<string, string | number | boolean | null>;

export type AuditEvent = {
  action: AuditAction;
  actor: AuditActor;
  target?: AuditTarget;
  details?: AuditDetails;
  ip?: string;
  userAgent?: string;
};

export type AuditRequest = { ip: string; userAgent?: string };

const requestStore = new AsyncLocalStorage<AuditRequest>();

/**
 * Runs a request handler with its client metadata, so events recorded anywhere below it
 * carry the client address and user agent without threading them through every call.
 */
export const runWithAuditRequest = <T>(request: AuditRequest, handler: () => T) =>
  requestStore.run(request, handler);

export const auditUser = (user: { id: string; email: string }): AuditActor => ({
  type: "user",
  id: user.id,
  label: user.email,
});

export type RecordedAuditEvent = AuditEvent & { at: number };
export type AuditSink = (events: RecordedAuditEvent[]) => Promise<void>;

type AuditState = {
  sink: AuditSink | null;
  queue: RecordedAuditEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  flushing: Promise<void> | null;
};

const globalForAudit = globalThis as typeof globalThis & {
  __nimbusAudit?: AuditState;
};
// Next.js route bundles and the custom server load separate module copies in one process.
const state: AuditState = (globalForAudit.__nimbusAudit ??= {
  sink: null,
  queue: [],
  timer: null,
  flushing: null,
});

const flushDelayMs = 250;
const retryDelayMs = 5_000;
const maxBatch = 200;
const maxQueued = 10_000;

function schedule(delay = flushDelayMs) {
  if (state.timer || !state.sink) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushAudit();
  }, delay);
  state.timer.unref?.();
}

/** Queues an audit event. Safe to call from any request path. */
export function recordAudit(event: AuditEvent) {
  if (state.queue.length >= maxQueued) {
    console.error(
      `Nimbus audit queue is full (${maxQueued} events). Dropping "${event.action}". Check that the database is writable; earlier events remain queued.`,
    );
    return;
  }
  const request = requestStore.getStore();
  state.queue.push({
    ...(request && { ip: request.ip, userAgent: request.userAgent }),
    ...event,
    at: Date.now(),
  });
  schedule();
}

/** Writes every queued event now. Used at shutdown and by tests. */
export async function flushAudit(): Promise<void> {
  if (state.flushing) await state.flushing;
  const sink = state.sink;
  if (!sink || state.queue.length === 0) return;
  const batch = state.queue.splice(0, maxBatch);
  let failed = false;
  state.flushing = sink(batch)
    .catch((error: unknown) => {
      failed = true;
      state.queue.unshift(...batch);
      console.error(
        `Nimbus could not write ${batch.length} audit events. They stay queued and will be retried in ${retryDelayMs / 1000} seconds.`,
        error,
      );
    })
    .finally(() => {
      state.flushing = null;
    });
  await state.flushing;
  if (failed) schedule(retryDelayMs);
  else if (state.queue.length > 0) await flushAudit();
}

/** Installs the persistent writer. Events recorded before installation are kept. */
export function setAuditSink(sink: AuditSink | null) {
  state.sink = sink;
  if (sink && state.queue.length > 0) schedule();
}

/** Clears queued events and the installed sink. Tests only. */
export function resetAuditForTest() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.queue.length = 0;
  state.sink = null;
}
