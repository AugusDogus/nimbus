import { randomBytes } from "node:crypto";
import { and, count, eq, gt, lt } from "drizzle-orm";
import { auditUser, recordAudit } from "@nimbus/api/audit";
import { user } from "../db/auth-schema";
import { devicePairings, libraries } from "../db/library-schema";
import { accountActor } from "../mcp/oauth/audit";
import { hashToken, mintSecret } from "../mcp/oauth/secrets";
import { Libraries } from "./libraries";
import { LibraryApiError } from "./library-api-error";
import type { BrowserSession, LibraryContext } from "./library-context";
import { LibraryThrottle } from "./library-throttle";
import { PairedDevices } from "./paired-devices";
import { PairingCode } from "./pairing-code";
import { PairingTicket } from "./pairing-ticket";

/**
 * Pairing a device, after RFC 8628: the device starts a request and shows a short pairing code,
 * its owner approves that code on a signed-in phone or browser, and the device, polling with its
 * secret device code, receives its token exactly once. An unapproved request grants nothing.
 *
 * States: `pending` until the owner decides, then `approved` or `denied`; `approved` becomes
 * `redeemed` when the device collects its token. Each step is a compare-and-set on the row, so a
 * request is decided once and redeemed once. Past `expiresAt` every state reads as expired.
 */

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const POLL_INTERVAL_SECONDS = 5;
/** Pending requests everyone together may have open, counted in SQLite. */
export const MAX_PENDING_PAIRINGS = 200;
const deviceCodePrefix = "nimbus_pairing_";

export type PairStart = {
  deviceCode: string;
  pairingCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
};

export type PairPoll =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | {
      status: "approved";
      token: string;
      library: { id: string; title: string };
    };

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LibraryApiError };

/** What the pairing page shows for a code before the owner decides. */
export type PairingReview = {
  pairingId: string;
  /** As the device supplied it: an untrusted label. */
  deviceName: string;
  pairingCode: string;
  requestedAt: number;
  expiresAt: number;
  account: { email: string };
  libraries: {
    id: string;
    title: string;
    folders: string[];
    devices: string[];
  }[];
  ticket: string;
};

export type PairingRefusal = {
  kind: "invalid" | "forbidden" | "not_found" | "rate_limited";
  message: string;
  retryAfterSeconds?: number;
};

export type PairingResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PairingRefusal };

export type PairingDecision =
  | { kind: "approve"; libraryId: string }
  | { kind: "deny" };

/**
 * A device name is shown to people, so it may not hold control characters, invisible format
 * characters such as bidirectional marks and overrides (Unicode Cc and Cf), or line breaks,
 * any of which could make it read differently from what it is.
 */
const deviceNamePattern = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;

const invalidRequest = (message: string): LibraryApiError => ({
  code: "invalid_request",
  message,
});

/** The device name a device supplied, trimmed, or the error explaining what it must be. */
function parseDeviceName(value: unknown): ApiResult<string> {
  // Checked as sent, before trimming, which would quietly drop a BOM or a trailing line break.
  const raw = typeof value === "string" ? value : "";
  const name = raw.normalize("NFC").trim();
  if (
    !name ||
    [...name].length > 80 ||
    !deviceNamePattern.test(raw) ||
    !deviceNamePattern.test(name)
  )
    return {
      ok: false,
      error: invalidRequest(
        "deviceName must be 1 to 80 characters without control, invisible formatting or line break characters. No pairing was started.",
      ),
    };
  return { ok: true, value: name };
}

const impersonationRefused: PairingRefusal = {
  kind: "forbidden",
  message:
    "You are signed in as this person by an administrator, so you cannot pair a device to their account. Stop impersonating, then sign in as yourself. No device was paired.",
};

const noSuchCode: PairingRefusal = {
  kind: "not_found",
  message:
    "No device is waiting for this code. Check the code on the device, or start pairing again on the device to get a new one. No device was paired.",
};

const throttled = (decision: {
  allowed: false;
  retryAfterSeconds: number;
}): PairingRefusal => ({
  kind: "rate_limited",
  message: `Too many attempts. Wait ${Math.ceil(decision.retryAfterSeconds / 60)} minutes and try again. No device was paired.`,
  retryAfterSeconds: decision.retryAfterSeconds,
});

/** An approval no device has collected yet, as Settings lists it. */
export type WaitingPairing = {
  id: string;
  deviceName: string;
  library: { id: string; title: string };
  approvedAt: number;
  expiresAt: number;
};

export const DevicePairing = {
  parseDeviceName,

  /** `ownerId`'s approvals still waiting for their device to collect its token. */
  waiting(ctx: Pick<LibraryContext, "db" | "now">, ownerId: string) {
    return ctx.db
      .select({
        id: devicePairings.id,
        deviceName: devicePairings.deviceName,
        libraryId: libraries.id,
        libraryTitle: libraries.title,
        approvedAt: devicePairings.decidedAt,
        expiresAt: devicePairings.expiresAt,
      })
      .from(devicePairings)
      .innerJoin(libraries, eq(libraries.id, devicePairings.libraryId))
      .where(
        and(
          eq(devicePairings.ownerId, ownerId),
          eq(devicePairings.state, "approved"),
          gt(devicePairings.expiresAt, ctx.now()),
        ),
      )
      .all()
      .map(
        ({
          libraryId,
          libraryTitle,
          approvedAt,
          ...pairing
        }): WaitingPairing => ({
          ...pairing,
          approvedAt: approvedAt ?? pairing.expiresAt - PAIRING_TTL_MS,
          library: { id: libraryId, title: libraryTitle },
        }),
      );
  },

  /**
   * Withdraw one of `owner`'s approvals before its device collects the token: its next poll is
   * answered `denied`. False when it is gone, collected, or someone else's.
   */
  cancel(
    ctx: Pick<LibraryContext, "db" | "now">,
    owner: { id: string; email: string },
    pairingId: string,
  ) {
    const [cancelled] = ctx.db
      .update(devicePairings)
      .set({ state: "denied", ownerId: null, libraryId: null })
      .where(
        and(
          eq(devicePairings.id, pairingId),
          eq(devicePairings.ownerId, owner.id),
          eq(devicePairings.state, "approved"),
        ),
      )
      .returning({ deviceName: devicePairings.deviceName })
      .all();
    if (!cancelled) return false;
    recordAudit({
      action: "device.pairing_denied",
      actor: auditUser(owner),
      target: { type: "device", id: pairingId, label: cancelled.deviceName },
      details: { by: "settings" },
    });
    return true;
  },

  /** POST /pair/start: open a request for `deviceName` from the client at `address`. */
  start(
    ctx: Pick<LibraryContext, "db" | "origin" | "now">,
    deviceName: string,
    address: string,
  ): ApiResult<PairStart> {
    if (ctx.origin.kind !== "configured")
      return {
        ok: false,
        error: { code: "service_unavailable", message: ctx.origin.reason },
      };
    const now = ctx.now();
    const limit = LibraryThrottle.hit(
      [
        { key: address, rule: "startPerAddress" },
        { key: "all", rule: "startGlobal" },
      ],
      now,
    );
    if (!limit.allowed)
      return {
        ok: false,
        error: LibraryApiError.rateLimited(limit.retryAfterSeconds),
      };
    // Expired requests are of no further use: an unknown code polls as expired too.
    ctx.db
      .delete(devicePairings)
      .where(lt(devicePairings.expiresAt, now))
      .run();
    const [open] = ctx.db
      .select({ pending: count() })
      .from(devicePairings)
      .where(
        and(
          eq(devicePairings.state, "pending"),
          gt(devicePairings.expiresAt, now),
        ),
      )
      .all();
    if ((open?.pending ?? 0) >= MAX_PENDING_PAIRINGS)
      return {
        ok: false,
        error: {
          code: "rate_limited",
          message:
            "Too many devices are waiting to be paired with this server. Wait a few minutes and try again. No pairing was started.",
          retryAfterSeconds: 60,
        },
      };
    const device = mintSecret(deviceCodePrefix);
    // A clash with a live code is about one in 850 billion; drawing again settles it.
    for (let attempt = 0; attempt < 3; attempt++) {
      const pairingCode = PairingCode.generate();
      const inserted = ctx.db
        .insert(devicePairings)
        .values({
          id: `pair_${randomBytes(16).toString("base64url")}`,
          deviceCodeHash: device.hash,
          pairingCodeHash: hashToken(pairingCode),
          deviceName,
          state: "pending",
          createdAt: now,
          expiresAt: now + PAIRING_TTL_MS,
          intervalSeconds: POLL_INTERVAL_SECONDS,
        })
        .onConflictDoNothing({ target: devicePairings.pairingCodeHash })
        .returning({ id: devicePairings.id })
        .all();
      if (inserted.length === 0) continue;
      const verificationUrl = `${ctx.origin.origin}/pair`;
      return {
        ok: true,
        value: {
          deviceCode: device.secret,
          pairingCode: PairingCode.display(pairingCode),
          verificationUrl,
          verificationUrlComplete: `${verificationUrl}?code=${PairingCode.display(pairingCode)}`,
          expiresIn: PAIRING_TTL_MS / 1000,
          interval: POLL_INTERVAL_SECONDS,
        },
      };
    }
    throw new Error(
      "Nimbus drew three pairing codes already in use, which should not happen with a working random source. No pairing was started.",
    );
  },

  /** POST /pair/poll: the device asks how its request stands, proving itself with `deviceCode`. */
  poll(
    ctx: Pick<LibraryContext, "db" | "now">,
    deviceCode: string,
    address: string,
  ): ApiResult<PairPoll> {
    const now = ctx.now();
    const limit = LibraryThrottle.hit(
      [{ key: address, rule: "pollPerAddress" }],
      now,
    );
    if (!limit.allowed)
      return {
        ok: false,
        error: LibraryApiError.rateLimited(limit.retryAfterSeconds),
      };
    const expired = { ok: true, value: { status: "expired" } } as const;
    if (!deviceCode.startsWith(deviceCodePrefix)) return expired;
    const [row] = ctx.db
      .select()
      .from(devicePairings)
      .where(eq(devicePairings.deviceCodeHash, hashToken(deviceCode)))
      .all();
    if (!row || row.state === "redeemed" || row.expiresAt <= now)
      return expired;
    if (
      row.lastPolledAt !== null &&
      now - row.lastPolledAt < row.intervalSeconds * 1000
    ) {
      const interval = row.intervalSeconds + 5;
      ctx.db
        .update(devicePairings)
        .set({ intervalSeconds: interval, lastPolledAt: now })
        .where(eq(devicePairings.id, row.id))
        .run();
      return {
        ok: false,
        error: {
          code: "slow_down",
          message: `This device is checking too often. Wait ${interval} seconds between checks from now on.`,
          retryAfterSeconds: interval,
          interval,
        },
      };
    }
    if (row.state === "pending" || row.state === "denied") {
      ctx.db
        .update(devicePairings)
        .set({ lastPolledAt: now })
        .where(eq(devicePairings.id, row.id))
        .run();
      return { ok: true, value: { status: row.state } };
    }
    return DevicePairing.redeem(ctx, row.id, now);
  },

  /**
   * Hand an approved request its token, once: the row moves from `approved` to `redeemed` in
   * the same transaction that records the paired device. The token is minted there and only its
   * hash is stored, so it exists in plain text only in this response.
   */
  redeem(
    ctx: Pick<LibraryContext, "db">,
    pairingId: string,
    now: number,
  ): ApiResult<PairPoll> {
    // Synchronous, so the transaction commits exactly these statements.
    const outcome = ctx.db.transaction((tx) => {
      const [claimed] = tx
        .update(devicePairings)
        .set({ state: "redeemed", lastPolledAt: now })
        .where(
          and(
            eq(devicePairings.id, pairingId),
            eq(devicePairings.state, "approved"),
          ),
        )
        .returning()
        .all();
      if (!claimed?.ownerId || !claimed.libraryId) return null;
      const [library] = tx
        .select({ id: libraries.id, title: libraries.title })
        .from(libraries)
        .innerJoin(user, eq(user.id, libraries.ownerId))
        .where(
          and(
            eq(libraries.id, claimed.libraryId),
            eq(libraries.ownerId, claimed.ownerId),
            eq(user.banned, false),
          ),
        )
        .all();
      if (!library) return null;
      const { token } = PairedDevices.create(tx, {
        ownerId: claimed.ownerId,
        libraryId: library.id,
        deviceName: claimed.deviceName,
        parentHash: claimed.deviceCodeHash,
        now,
      });
      return { library, token };
    });
    if (!outcome) return { ok: true, value: { status: "expired" } };
    return {
      ok: true,
      value: {
        status: "approved",
        token: outcome.token,
        library: { id: outcome.library.id, title: outcome.library.title },
      },
    };
  },

  /** The pairing page looks up the code an owner typed, before they decide. */
  async review(
    ctx: Pick<LibraryContext, "db" | "now" | "secret">,
    session: BrowserSession,
    input: string,
    address: string,
  ): Promise<PairingResult<PairingReview>> {
    if (session.impersonatedBy !== null)
      return { ok: false, error: impersonationRefused };
    const now = ctx.now();
    const limit = LibraryThrottle.hit(
      [
        { key: session.userId, rule: "reviewPerAccount" },
        { key: address, rule: "reviewPerAddress" },
        { key: "all", rule: "reviewGlobal" },
      ],
      now,
    );
    if (!limit.allowed) return { ok: false, error: throttled(limit) };
    const code = PairingCode.parse(input);
    if (code === null)
      return {
        ok: false,
        error: {
          kind: "invalid",
          message:
            "Enter the 8-character code shown on the device, such as B7KD-M4Q9. No device was paired.",
        },
      };
    const [row] = ctx.db
      .select()
      .from(devicePairings)
      .where(
        and(
          eq(devicePairings.pairingCodeHash, hashToken(code)),
          eq(devicePairings.state, "pending"),
          gt(devicePairings.expiresAt, now),
        ),
      )
      .all();
    if (!row) return { ok: false, error: noSuchCode };
    const [account] = ctx.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, session.userId))
      .all();
    return {
      ok: true,
      value: {
        pairingId: row.id,
        deviceName: row.deviceName,
        pairingCode: PairingCode.display(code),
        requestedAt: row.createdAt,
        expiresAt: row.expiresAt,
        account: { email: account?.email ?? "" },
        libraries: Libraries.list(ctx, session.userId).map((library) => ({
          id: library.id,
          title: library.title,
          folders: library.folders,
          devices: library.devices.map((device) => device.name),
        })),
        ticket: PairingTicket.issue(ctx, session, row.id),
      },
    };
  },

  /**
   * Allow or Deny a pending request from the pairing page. The ticket proves the page was
   * shown to this session for this request; the compare-and-set on the pending row makes a
   * double submission, or a second phone deciding the same code, change nothing.
   */
  async decide(
    ctx: Pick<LibraryContext, "db" | "now" | "secret">,
    session: BrowserSession,
    input: { pairingId: string; ticket: string; decision: PairingDecision },
    address: string,
  ): Promise<PairingResult<{ deviceName: string }>> {
    if (session.impersonatedBy !== null)
      return { ok: false, error: impersonationRefused };
    const now = ctx.now();
    const limit = LibraryThrottle.hit(
      [
        { key: session.userId, rule: "decidePerAccount" },
        { key: address, rule: "decidePerAddress" },
        { key: "all", rule: "decideGlobal" },
      ],
      now,
    );
    if (!limit.allowed) return { ok: false, error: throttled(limit) };
    if (!PairingTicket.verify(ctx, input.ticket, session, input.pairingId))
      return {
        ok: false,
        error: {
          kind: "forbidden",
          message:
            "This page expired or was opened in another sign-in. Enter the code from the device again. No device was paired.",
        },
      };
    const { decision } = input;
    if (decision.kind === "approve") {
      const [library] = ctx.db
        .select({ id: libraries.id })
        .from(libraries)
        .where(
          and(
            eq(libraries.id, decision.libraryId),
            eq(libraries.ownerId, session.userId),
          ),
        )
        .all();
      if (!library || Libraries.folders(ctx, library.id).length === 0)
        return {
          ok: false,
          error: {
            kind: "not_found",
            message:
              "That library was deleted or has no folders. Choose another library or create one in Settings. No device was paired.",
          },
        };
    }
    const [decided] = ctx.db
      .update(devicePairings)
      .set(
        decision.kind === "approve"
          ? {
              state: "approved",
              ownerId: session.userId,
              libraryId: decision.libraryId,
              decidedAt: now,
            }
          : { state: "denied", decidedAt: now },
      )
      .where(
        and(
          eq(devicePairings.id, input.pairingId),
          eq(devicePairings.state, "pending"),
          gt(devicePairings.expiresAt, now),
        ),
      )
      .returning({ deviceName: devicePairings.deviceName })
      .all();
    if (!decided)
      return {
        ok: false,
        error: {
          kind: "not_found",
          message:
            "This code was already approved or denied, or it expired. Nothing more was changed. To pair the device, start pairing again on it.",
        },
      };
    recordAudit({
      action:
        decision.kind === "approve"
          ? "device.pairing_approved"
          : "device.pairing_denied",
      actor: await accountActor(ctx.db, session.userId),
      target: {
        type: "device",
        id: input.pairingId,
        label: decided.deviceName,
      },
      details:
        decision.kind === "approve" ? { library: decision.libraryId } : {},
    });
    return { ok: true, value: { deviceName: decided.deviceName } };
  },
} as const;
