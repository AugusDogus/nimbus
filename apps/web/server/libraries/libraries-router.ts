import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "@nimbus/api";
import { allowedOrigins } from "@/lib/auth";
import { ClientIp } from "../client-ip";
import { RequestOrigin } from "../request-origin";
import { DevicePairing, type PairingRefusal } from "./device-pairing";
import { Libraries, type LibraryRefusal } from "./libraries";
import { LibraryCatalog } from "./library-catalog";
import type { BrowserSession } from "./library-context";
import { libraryRuntime } from "./library-runtime";
import { PairedDevices } from "./paired-devices";

/**
 * Settings, Libraries and the pairing page: cookie-authenticated procedures of the signed-in
 * owner. Changes must come from Nimbus's own pages, as for other cookie-authenticated writes.
 */

const codes = {
  invalid: "BAD_REQUEST",
  forbidden: "FORBIDDEN",
  not_found: "NOT_FOUND",
  confirm_devices: "PRECONDITION_FAILED",
  rate_limited: "TOO_MANY_REQUESTS",
} as const;

const refused = (error: LibraryRefusal | PairingRefusal) =>
  new TRPCError({ code: codes[error.kind], message: error.message });

const fromNimbusPage = protectedProcedure.use(({ ctx, next }) => {
  if (!RequestOrigin.fromNimbus(ctx, allowedOrigins))
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This request did not come from a Nimbus page. Nothing was changed.",
    });
  return next();
});

/** The signed-in browser session, which the pairing page binds its tickets to. */
const browserSession = (ctx: {
  access: { user: { id: string } };
  session: { session?: { id?: string } };
  impersonatedBy: string | null;
}): BrowserSession => {
  const sessionId = ctx.session.session?.id;
  if (!sessionId)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sign in to Nimbus in this browser to pair a device.",
    });
  return {
    userId: ctx.access.user.id,
    sessionId,
    impersonatedBy: ctx.impersonatedBy,
  };
};

const address = (headers: Headers) =>
  ClientIp.bucket(ClientIp.fromHeaders(headers));

const libraryInput = z.object({
  title: z.string().max(400),
  folders: z.array(z.string().max(4096)).max(50),
});

export const librariesRouter = router({
  settings: protectedProcedure.query(({ ctx }) => {
    const runtime = libraryRuntime();
    return {
      pairing:
        runtime.origin.kind === "configured"
          ? ({ kind: "available" } as const)
          : ({ kind: "unavailable", reason: runtime.origin.reason } as const),
      libraries: Libraries.list(runtime, ctx.access.user.id),
      devices: PairedDevices.list(runtime, ctx.access.user.id),
      waiting: DevicePairing.waiting(runtime, ctx.access.user.id),
    };
  }),
  createLibrary: fromNimbusPage
    .input(libraryInput)
    .mutation(async ({ ctx, input }) => {
      const runtime = libraryRuntime();
      const created = await Libraries.create(
        runtime,
        ctx.access,
        ctx.impersonatedBy !== null,
        input,
      );
      if (!created.ok) throw refused(created.error);
      void LibraryCatalog.refreshLibrary(runtime, created.value.id).catch(
        () => undefined,
      );
      return created.value;
    }),
  updateLibrary: fromNimbusPage
    .input(
      libraryInput.extend({
        id: z.string().max(200),
        acknowledgedDevices: z.array(z.string().max(200)).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const runtime = libraryRuntime();
      const updated = await Libraries.update(
        runtime,
        ctx.access,
        ctx.impersonatedBy !== null,
        input,
      );
      if (!updated.ok) throw refused(updated.error);
      void LibraryCatalog.refreshLibrary(runtime, updated.value.id).catch(
        () => undefined,
      );
      return updated.value;
    }),
  deleteLibrary: fromNimbusPage
    .input(z.object({ id: z.string().max(200) }))
    .mutation(({ ctx, input }) => {
      const removed = Libraries.remove(
        libraryRuntime(),
        ctx.access,
        ctx.impersonatedBy !== null,
        input.id,
      );
      if (!removed.ok) throw refused(removed.error);
      LibraryCatalog.forget(input.id);
      return removed.value;
    }),
  revokeDevice: fromNimbusPage
    .input(z.object({ id: z.string().max(200) }))
    .mutation(({ ctx, input }) => {
      if (ctx.impersonatedBy !== null)
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "You are signed in as this person by an administrator, so you cannot disconnect their devices. Nothing was changed.",
        });
      if (!PairedDevices.revoke(libraryRuntime(), ctx.access.user, input.id))
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "This device is already disconnected. Reload the page to see your devices.",
        });
      return { revoked: true };
    }),
  /** Withdraw an approval its device has not collected yet. */
  cancelPairing: fromNimbusPage
    .input(z.object({ id: z.string().max(200) }))
    .mutation(({ ctx, input }) => {
      if (ctx.impersonatedBy !== null)
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "You are signed in as this person by an administrator, so you cannot change their devices. Nothing was changed.",
        });
      if (!DevicePairing.cancel(libraryRuntime(), ctx.access.user, input.id))
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "This device already finished pairing, or the approval expired. Reload the page to see your devices.",
        });
      return { cancelled: true };
    }),
  /** Look up the code typed on the pairing page. A mutation: it is counted and issues a ticket. */
  review: fromNimbusPage
    .input(z.object({ pairingCode: z.string().max(40) }))
    .mutation(async ({ ctx, input }) => {
      const reviewed = await DevicePairing.review(
        libraryRuntime(),
        browserSession(ctx),
        input.pairingCode,
        address(ctx.headers),
      );
      if (!reviewed.ok) throw refused(reviewed.error);
      return reviewed.value;
    }),
  decide: fromNimbusPage
    .input(
      z.object({
        pairingId: z.string().max(200),
        ticket: z.string().max(2000),
        decision: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("approve"),
            libraryId: z.string().max(200),
          }),
          z.object({ kind: z.literal("deny") }),
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const decided = await DevicePairing.decide(
        libraryRuntime(),
        browserSession(ctx),
        input,
        address(ctx.headers),
      );
      if (!decided.ok) throw refused(decided.error);
      return decided.value;
    }),
});
