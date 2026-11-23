import type { ScopeAuthority } from "@nimbus/api/file-mutations";
import type { HeldScope, Release } from "@nimbus/api/path-locks";
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
  { kind: "drain" | "active" | "alone" }
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
      /** Hear drain, active and alone. Messages that arrive before a listener wait for it. */
      onLifecycle: (listener: (message: LifecycleMessage) => void) => void;
      /** Hear transfer signals other workers raised. */
      onTransferSignal: (listener: (signal: TransferSignal) => void) => void;
      /** Called once if the supervisor goes away. */
      onDisconnect: (listener: () => void) => void;
    };

export type SupervisionError = { kind: "supervision"; message: string };

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
  if (!release || !process.send)
    return fail(
      `${WorkerEnv.protocol} is set, but this process has no IPC channel or ${WorkerEnv.release} is missing, so it was not started by the supervisor. Unset ${WorkerEnv.protocol} to run Nimbus on its own.`,
    );
  const send = (message: WorkerMessage) => void process.send?.(message);
  const scopes = remoteScopes(send);
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
    },
  };
}

export const Supervision = { fromProcess, remoteScopes } as const;
