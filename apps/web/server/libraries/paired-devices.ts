import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, type SQL } from "drizzle-orm";
import { auditUser, recordAudit, type AuditActor } from "@nimbus/api/audit";
import { user } from "../db/auth-schema";
import {
  devicePairings,
  libraries,
  pairedDevices,
  type DeviceRevocationReason,
} from "../db/library-schema";
import { mcpClients, mcpGrants, mcpTokens } from "../db/mcp-schema";
import { accountActor } from "../mcp/oauth/audit";
import { hashToken, mintSecret } from "../mcp/oauth/secrets";
import type { LibraryApiError } from "./library-api-error";
import type { LibraryContext } from "./library-context";

/**
 * Paired devices, kept in the OAuth grant store beside MCP connections: each is a grant of the
 * `device` resource with one `device_token`, bound to one library by a `nimbus_paired_device`
 * row. Revoking the grant ends the device, so the account-security actions that revoke grants
 * end devices too. MCP listings and checks only ever see `mcp` grants.
 */

/**
 * The server's own client registration that device grants belong to. It has no redirect URIs,
 * so no browser authorization can ever issue a code for it.
 */
export const PAIRED_DEVICE_CLIENT_ID = "nimbus-paired-device";
const scope = "library:read";
/** Prefix of device tokens, so secret scanners can recognize a leaked one. */
const tokenPrefix = "nimbus_device_";
/**
 * A paired device unused this long is disconnected and must pair again. Each authorized
 * request slides the deadline; failed, refused and rate-limited requests do not.
 */
export const DEVICE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** Last-used times are written at most this often per device, as for MCP connections. */
const LAST_USED_RESOLUTION_MS = 60 * 1000;

/** A paired device whose token authenticated this request. */
export type PairedDevice = {
  id: string;
  name: string;
  ownerId: string;
  libraryId: string;
  tokenHash: string;
  /** When the device was last used, to the minute, for `touch`. */
  lastUsedAt: number;
};

export type DeviceAuth =
  | { ok: true; device: PairedDevice }
  | { ok: false; error: LibraryApiError };

/** A paired device as its owner's Settings lists it. */
export type PairedDeviceListing = {
  id: string;
  name: string;
  library: { id: string; title: string };
  pairedAt: number;
  lastUsedAt: number;
};

type Transaction = Parameters<
  Parameters<LibraryContext["db"]["transaction"]>[0]
>[0];

const revoked = (message: string): DeviceAuth => ({
  ok: false,
  error: { code: "token_revoked", message },
});
const invalid: DeviceAuth = {
  ok: false,
  error: {
    code: "token_invalid",
    message:
      "This device's sign-in is not recognized by this Nimbus server. Pair the device again.",
  },
};

/** Revoke the live device grants among `grantIds`, recording each for `actor`. Returns how many. */
function revokeGrants(
  ctx: Pick<LibraryContext, "db" | "now">,
  grantIds: string[],
  reason: DeviceRevocationReason,
  actor: AuditActor,
) {
  if (!grantIds.length) return 0;
  const rows = ctx.db.transaction((tx) => {
    const ended = tx
      .update(mcpGrants)
      .set({ revokedAt: ctx.now() })
      .where(
        and(
          inArray(mcpGrants.id, grantIds),
          eq(mcpGrants.resource, "device"),
          isNull(mcpGrants.revokedAt),
        ),
      )
      .returning({ id: mcpGrants.id })
      .all();
    if (!ended.length) return [];
    const ids = ended.map((row) => row.id);
    return tx
      .update(pairedDevices)
      .set({ revokedReason: reason })
      .where(inArray(pairedDevices.grantId, ids))
      .returning({ id: pairedDevices.grantId, name: pairedDevices.deviceName })
      .all();
  });
  for (const row of rows)
    recordAudit({
      action: "device.revoked",
      actor,
      target: { type: "device", id: row.id, label: row.name },
      details: { reason },
    });
  return rows.length;
}

/** The live device grants matching `where` on the grant and its binding. */
const liveGrantIds = (
  ctx: Pick<LibraryContext, "db">,
  where: SQL | undefined,
) =>
  ctx.db
    .select({ id: mcpGrants.id })
    .from(mcpGrants)
    .innerJoin(pairedDevices, eq(pairedDevices.grantId, mcpGrants.id))
    .where(
      and(where, eq(mcpGrants.resource, "device"), isNull(mcpGrants.revokedAt)),
    )
    .all()
    .map((row) => row.id);

export const PairedDevices = {
  tokenPrefix,

  /**
   * Record a newly paired device inside the caller's transaction: its grant, its token (only the
   * hash, issued from `parentHash`, the device code's hash) and its library binding. Returns the
   * token, which exists in plain text only for the response that hands it over.
   */
  create(
    tx: Transaction,
    device: {
      ownerId: string;
      libraryId: string;
      deviceName: string;
      parentHash: string;
      now: number;
    },
  ) {
    tx.insert(mcpClients)
      .values({
        clientId: PAIRED_DEVICE_CLIENT_ID,
        clientName: "Paired device",
        redirectUrisJson: "[]",
        tokenEndpointAuthMethod: "none",
        scope,
        createdAt: device.now,
      })
      .onConflictDoNothing()
      .run();
    const grantId = `dev_${randomBytes(16).toString("base64url")}`;
    const token = mintSecret(tokenPrefix);
    tx.insert(mcpGrants)
      .values({
        id: grantId,
        userId: device.ownerId,
        clientId: PAIRED_DEVICE_CLIENT_ID,
        scope,
        resource: "device",
        createdAt: device.now,
        lastUsedAt: device.now,
      })
      .run();
    tx.insert(mcpTokens)
      .values({
        hash: token.hash,
        kind: "device_token",
        grantId,
        scope,
        expiresAt: device.now + DEVICE_IDLE_MS,
        createdAt: device.now,
        parentHash: device.parentHash,
      })
      .run();
    tx.insert(pairedDevices)
      .values({
        grantId,
        libraryId: device.libraryId,
        deviceName: device.deviceName,
      })
      .run();
    return { grantId, token: token.secret };
  },

  /**
   * The paired device presenting `Authorization: Bearer`, checked against the database on every
   * request: its token, its grant's revocation, its owner's account and its idle deadline.
   */
  authenticate(
    ctx: Pick<LibraryContext, "db" | "now">,
    request: Request,
  ): DeviceAuth {
    const header = request.headers.get("authorization");
    if (header === null)
      return {
        ok: false,
        error: {
          code: "authorization_required",
          message:
            "This request needs the device's sign-in. Send it as Authorization: Bearer, or pair the device first.",
        },
      };
    const token = /^Bearer +(\S+)\s*$/i.exec(header)?.[1];
    if (!token?.startsWith(tokenPrefix) || token.length > 200) return invalid;
    const [row] = ctx.db
      .select({
        grantId: mcpGrants.id,
        name: pairedDevices.deviceName,
        ownerId: mcpGrants.userId,
        libraryId: pairedDevices.libraryId,
        expiresAt: mcpTokens.expiresAt,
        tokenHash: mcpTokens.hash,
        lastUsedAt: mcpGrants.lastUsedAt,
        createdAt: mcpGrants.createdAt,
        revokedAt: mcpGrants.revokedAt,
        banned: user.banned,
      })
      .from(mcpTokens)
      .innerJoin(mcpGrants, eq(mcpGrants.id, mcpTokens.grantId))
      .innerJoin(pairedDevices, eq(pairedDevices.grantId, mcpGrants.id))
      .innerJoin(user, eq(user.id, mcpGrants.userId))
      .where(
        and(
          eq(mcpTokens.hash, hashToken(token)),
          eq(mcpTokens.kind, "device_token"),
          eq(mcpGrants.resource, "device"),
        ),
      )
      .limit(1)
      .all();
    if (!row) return invalid;
    if (row.revokedAt !== null || row.libraryId === null)
      return revoked(
        "This device was disconnected from Nimbus. Pair it again.",
      );
    if (row.banned)
      return revoked(
        "The Nimbus account this device belongs to is disabled. Ask a Nimbus administrator to restore it, then pair the device again.",
      );
    if (row.expiresAt <= ctx.now()) {
      revokeGrants(ctx, [row.grantId], "idle_lapsed", { type: "system" });
      return revoked(
        "This device was not used for 30 days, so Nimbus disconnected it. Pair it again.",
      );
    }
    return {
      ok: true,
      device: {
        id: row.grantId,
        name: row.name,
        ownerId: row.ownerId,
        libraryId: row.libraryId,
        tokenHash: row.tokenHash,
        lastUsedAt: row.lastUsedAt ?? row.createdAt,
      },
    };
  },

  /**
   * Record that `device` was used for an authorized request: its idle deadline moves to 30 days
   * from now. At most one write a minute per device. The update requires a live grant and an
   * unexpired token, so it never brings a revoked or lapsed device back.
   */
  touch(ctx: Pick<LibraryContext, "db" | "now">, device: PairedDevice) {
    const now = ctx.now();
    if (device.lastUsedAt > now - LAST_USED_RESOLUTION_MS) return;
    ctx.db.transaction((tx) => {
      const live = tx
        .update(mcpGrants)
        .set({ lastUsedAt: now })
        .where(and(eq(mcpGrants.id, device.id), isNull(mcpGrants.revokedAt)))
        .returning({ id: mcpGrants.id })
        .all();
      if (!live.length) return;
      tx.update(mcpTokens)
        .set({ expiresAt: now + DEVICE_IDLE_MS })
        .where(
          and(
            eq(mcpTokens.hash, device.tokenHash),
            gt(mcpTokens.expiresAt, now),
          ),
        )
        .run();
    });
  },

  /** The live paired devices of `ownerId`, newest first. */
  list(
    ctx: Pick<LibraryContext, "db" | "now">,
    ownerId: string,
  ): PairedDeviceListing[] {
    return ctx.db
      .select({
        id: mcpGrants.id,
        name: pairedDevices.deviceName,
        libraryId: libraries.id,
        libraryTitle: libraries.title,
        pairedAt: mcpGrants.createdAt,
        lastUsedAt: mcpGrants.lastUsedAt,
      })
      .from(mcpGrants)
      .innerJoin(pairedDevices, eq(pairedDevices.grantId, mcpGrants.id))
      .innerJoin(libraries, eq(libraries.id, pairedDevices.libraryId))
      .innerJoin(
        mcpTokens,
        and(
          eq(mcpTokens.grantId, mcpGrants.id),
          eq(mcpTokens.kind, "device_token"),
        ),
      )
      .where(
        and(
          eq(mcpGrants.userId, ownerId),
          eq(mcpGrants.resource, "device"),
          isNull(mcpGrants.revokedAt),
          gt(mcpTokens.expiresAt, ctx.now()),
        ),
      )
      .orderBy(desc(mcpGrants.createdAt))
      .all()
      .map(({ libraryId, libraryTitle, lastUsedAt, ...device }) => ({
        ...device,
        lastUsedAt: lastUsedAt ?? device.pairedAt,
        library: { id: libraryId, title: libraryTitle },
      }));
  },

  /** Revoke one of `owner`'s own devices from Settings. False when it is gone or someone else's. */
  revoke(
    ctx: Pick<LibraryContext, "db" | "now">,
    owner: { id: string; email: string },
    deviceId: string,
  ) {
    const ids = liveGrantIds(
      ctx,
      and(eq(mcpGrants.id, deviceId), eq(mcpGrants.userId, owner.id)),
    );
    return revokeGrants(ctx, ids, "settings", auditUser(owner)) === 1;
  },

  /** Revoke the devices of a library being deleted. */
  revokeLibrary(
    ctx: Pick<LibraryContext, "db" | "now">,
    libraryId: string,
    owner: { id: string; email: string },
  ) {
    return revokeGrants(
      ctx,
      liveGrantIds(ctx, eq(pairedDevices.libraryId, libraryId)),
      "library_deleted",
      auditUser(owner),
    );
  },

  /**
   * Revoke every device of `userId`, as password changes and resets, second-factor resets,
   * signing out everywhere and disabling the account do, and cancel approvals no device has
   * collected yet. Returns how many devices were paired.
   */
  async revokeForUser(
    ctx: Pick<LibraryContext, "db" | "now">,
    userId: string,
    reason: DeviceRevocationReason,
  ) {
    ctx.db
      .update(devicePairings)
      .set({ state: "denied", ownerId: null, libraryId: null })
      .where(
        and(
          eq(devicePairings.ownerId, userId),
          eq(devicePairings.state, "approved"),
        ),
      )
      .run();
    const ids = liveGrantIds(ctx, eq(mcpGrants.userId, userId));
    if (!ids.length) return 0;
    return revokeGrants(ctx, ids, reason, await accountActor(ctx.db, userId));
  },
} as const;
