import type { ScopeAuthority } from "@nimbus/api/file-mutations";
import type { HeldScope, Release } from "@nimbus/api/path-locks";
import { HandoverStream, type HandoverEvent } from "./handover-stream";
import type {
  UpdateAudit,
  UpdatePanel,
  UpdateRequest,
} from "./update-protocol";
import {
  PROTOCOL_VERSION,
  Protocol,
  WorkerEnv,
  type SupervisorMessage,
  type TransferSignal,
  type WorkerMessage,
} from "./protocol";

/** What the supervisor tells a worker to do with its own lifetime. */
export type LifecycleMessage = Extract<
  SupervisorMessage,
  { kind: "drain" | "active" | "recover" }
>;

/** How this server was started: on its own, or as one of the supervisor's workers. */
export type Supervision =
  | { kind: "standalone" }
  | {
      kind: "supervised";
      release: string;
      /** Whether other workers still run while this one starts. */
      predecessor: boolean;
      previousAssets: string[];
      send: (message: WorkerMessage) => void;
      /** Path scopes granted by the supervisor, shared with every other worker. */
      scopes: ScopeAuthority;
      /** Hear drain, active and recover. Messages that arrive before a listener wait for it. */
      onLifecycle: (listener: (message: LifecycleMessage) => void) => void;
      /** Hear transfer signals other workers raised. */
      onTransferSignal: (listener: (signal: TransferSignal) => void) => void;
      /** Called once if the supervisor goes away. */
      onDisconnect: (listener: () => void) => void;
      /** The update requests of the administration page (see update-protocol.ts). */
      updates: UpdateChannel;
      /** Whether the supervisor that started this process still runs: it is still its parent. */
      supervisorAlive: () => boolean;
    };

export type SupervisionError = { kind: "supervision"; message: string };

export type UpdateAnswer =
  | { ok: true; panel: UpdatePanel }
  | { ok: false; message: string };

/** A worker's side of the update requests: each answered by its id. */
export type UpdateChannel = {
  /** The update page's state after `request`: a status, a check, a schedule. */
  ask: (
    request: Extract<UpdateRequest, { kind: "status" | "check" | "schedule" }>,
  ) => Promise<UpdateAnswer>;
  /**
   * Install or roll back, passing each event of the handover to `onEvent`: the `done` event, or
   * null when the supervisor went away before it.
   */
  act: (
    request: Extract<UpdateRequest, { kind: "install" | "rollback" }>,
    onEvent: (event: HandoverEvent) => void,
  ) => Promise<Extract<HandoverEvent, { kind: "done" }> | null>;
  /** Hear the outcomes of automatic installs, to record them. */
  onAudit: (listener: (entry: UpdateAudit) => void) => void;
};

/** How long a status, check or schedule may take before it is reported as unanswered. */
const ASK_TIMEOUT_MS = 120_000;

function updateChannel(send: (message: WorkerMessage) => void) {
  let next = 1;
  const asked = new Map<number, (answer: UpdateAnswer) => void>();
  const acting = new Map<
    number,
    {
      onEvent: (event: HandoverEvent) => void;
      settle: (done: Extract<HandoverEvent, { kind: "done" }> | null) => void;
    }
  >();
  let audit: (entry: UpdateAudit) => void = () => undefined;
  const channel: UpdateChannel = {
    ask(request) {
      const id = next++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          asked.delete(id);
          resolve({
            ok: false,
            message:
              "The supervisor did not answer within two minutes. Nothing was changed; try again.",
          });
        }, ASK_TIMEOUT_MS);
        asked.set(id, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        send({ kind: "update-request", id, request });
      });
    },
    act(request, onEvent) {
      const id = next++;
      return new Promise((settle) => {
        acting.set(id, { onEvent, settle });
        send({ kind: "update-request", id, request });
      });
    },
    onAudit(listener) {
      audit = listener;
    },
  };
  return {
    channel,
    answered(id: number, answer: UpdateAnswer) {
      const resolve = asked.get(id);
      asked.delete(id);
      resolve?.(answer);
      // An install or rollback refused at once is answered, not streamed.
      const waiting = acting.get(id);
      if (waiting && !answer.ok) {
        acting.delete(id);
        waiting.settle({
          kind: "done",
          ok: false,
          error: { kind: "update-failed", message: answer.message },
        });
      }
    },
    event(id: number, value: unknown) {
      const waiting = acting.get(id);
      const event = HandoverStream.parseEvent(value);
      if (!waiting || !event) return;
      waiting.onEvent(event);
      if (event.kind === "done") {
        acting.delete(id);
        waiting.settle(event);
      }
    },
    audit: (entry: UpdateAudit) => audit(entry),
    /** The supervisor went away: nothing more will be answered. */
    gone() {
      for (const resolve of asked.values())
        resolve({ ok: false, message: "The supervisor went away." });
      asked.clear();
      for (const waiting of acting.values()) waiting.settle(null);
      acting.clear();
    },
  };
}

/**
 * Scopes asked of the supervisor by id. A release runs at most once and is sent only after the
 * grant arrived, so the supervisor never sees a release for scopes it has not granted.
 */
function remoteScopes(send: (message: WorkerMessage) => void) {
  let next = 1;
  const waiting = new Map<number, (release: Release) => void>();
  const authority: ScopeAuthority = {
    acquire(scopes: readonly [HeldScope, ...HeldScope[]]) {
      const id = next++;
      return new Promise<Release>((resolve) => {
        waiting.set(id, resolve);
        send({ kind: "acquire-scopes", id, scopes: [...scopes] });
      });
    },
  };
  return {
    authority,
    granted(id: number) {
      const resolve = waiting.get(id);
      if (!resolve) return;
      waiting.delete(id);
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        send({ kind: "release-scopes", id });
      });
    },
  };
}

/** Supervised when the supervisor set its protocol variable; standalone otherwise. */
function fromProcess(
  env: Record<string, string | undefined> = process.env,
): { ok: true; value: Supervision } | { ok: false; error: SupervisionError } {
  const protocol = env[WorkerEnv.protocol];
  if (protocol === undefined)
    return { ok: true, value: { kind: "standalone" } };
  const fail = (message: string) => ({
    ok: false as const,
    error: { kind: "supervision" as const, message },
  });
  if (protocol !== String(PROTOCOL_VERSION))
    return fail(
      `This Nimbus release speaks supervisor protocol ${PROTOCOL_VERSION}, but its supervisor speaks ${protocol}. It did not start, and the release already serving keeps serving. Update the container image so the supervisor matches the release.`,
    );
  const release = env[WorkerEnv.release];
  const supervisorPid = Number(env[WorkerEnv.supervisorPid]);
  if (!release || !process.send || !Number.isSafeInteger(supervisorPid))
    return fail(
      `${WorkerEnv.protocol} is set, but this process has no IPC channel or ${WorkerEnv.release} or ${WorkerEnv.supervisorPid} is missing, so it was not started by the supervisor. Unset ${WorkerEnv.protocol} to run Nimbus on its own.`,
    );
  const send = (message: WorkerMessage) => void process.send?.(message);
  const scopes = remoteScopes(send);
  const updates = updateChannel(send);
  process.once("disconnect", () => updates.gone());
  let lifecycle: ((message: LifecycleMessage) => void) | null = null;
  const early: LifecycleMessage[] = [];
  let transfers: (signal: TransferSignal) => void = () => undefined;
  process.on("message", (value: unknown) => {
    const message = Protocol.parseSupervisorMessage(value);
    if (!message) {
      console.error(
        "Nimbus ignored a message from its supervisor that it does not understand; the supervisor and this release may not match.",
      );
      return;
    }
    switch (message.kind) {
      case "scopes-granted":
        scopes.granted(message.id);
        return;
      case "transfer-signal":
        transfers(message.signal);
        return;
      case "update-answer":
        updates.answered(message.id, message.answer);
        return;
      case "update-event":
        updates.event(message.id, message.event);
        return;
      case "update-audit":
        updates.audit(message.entry);
        return;
      default:
        if (lifecycle) lifecycle(message);
        else early.push(message);
    }
  });
  return {
    ok: true,
    value: {
      kind: "supervised",
      release,
      predecessor: env[WorkerEnv.predecessor] === "1",
      previousAssets: (env[WorkerEnv.previousAssets] ?? "")
        .split(":")
        .filter(Boolean),
      send,
      scopes: scopes.authority,
      onLifecycle(listener) {
        lifecycle = listener;
        for (const message of early.splice(0)) listener(message);
      },
      onTransferSignal(listener) {
        transfers = listener;
      },
      onDisconnect(listener) {
        process.once("disconnect", listener);
      },
      updates: updates.channel,
      supervisorAlive: () => process.ppid === supervisorPid,
    },
  };
}

export const Supervision = { fromProcess, remoteScopes } as const;
