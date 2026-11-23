import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, publicProcedure, router, t } from "@nimbus/api";
import { auditActions } from "@nimbus/api/audit";
import { appRouter } from "@nimbus/api/routers";
import { deviceLabel } from "@/lib/device-label";
import { oidcConfig } from "@/lib/oidc-config";
import { AuditQuery, listAuditEvents } from "./audit-log";
import { db } from "./db";
import { passkey, session as sessions, user } from "./db/schema";
import { mailConfig } from "./mail";
import { mcpResource, readMcpConfig } from "./mcp/config";
import { listConnections } from "./mcp/oauth/connections";
import { librariesRouter } from "./libraries/libraries-router";

/** The Better Auth session as the account page needs it, read from the request context. */
const SignedIn = z.object({
  session: z.object({ id: z.string().min(1) }),
  user: z.object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
  }),
});

const signedInProcedure = publicProcedure.use(({ ctx, next }) => {
  const parsed = SignedIn.safeParse(ctx.session);
  if (!parsed.success)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  return next({ ctx: { ...ctx, signedIn: parsed.data } });
});

const auditFilter = z.string().max(200).optional();

/**
 * Data the browser pages read that lived in server components before: sign-in options, the
 * account overview, MCP settings and the audit log. Merged with the shared API router, so the
 * client keeps one typed tRPC endpoint.
 */
const webOnlyRouter = router({
  signIn: router({
    options: publicProcedure.query(async () => {
      const [existing] = await db.select({ id: user.id }).from(user).limit(1);
      return {
        setupAvailable: !existing,
        singleSignOn: oidcConfig.kind === "oidc" ? oidcConfig.label : null,
        passwordReset: mailConfig.kind === "smtp",
      };
    }),
  }),
  account: router({
    overview: signedInProcedure.query(async ({ ctx }) => {
      const { session, user: profile } = ctx.signedIn;
      const [account, activeSessions, passkeys] = await Promise.all([
        db
          .select({ twoFactorEnabled: user.twoFactorEnabled })
          .from(user)
          .where(eq(user.id, profile.id)),
        db
          .select({
            id: sessions.id,
            userAgent: sessions.userAgent,
            ipAddress: sessions.ipAddress,
            updatedAt: sessions.updatedAt,
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.userId, profile.id),
              gt(sessions.expiresAt, new Date()),
            ),
          )
          .orderBy(desc(sessions.updatedAt)),
        db
          .select({
            id: passkey.id,
            name: passkey.name,
            createdAt: passkey.createdAt,
            deviceType: passkey.deviceType,
          })
          .from(passkey)
          .where(eq(passkey.userId, profile.id))
          .orderBy(desc(passkey.createdAt)),
      ]);
      return {
        name: profile.name,
        email: profile.email,
        twoFactorEnabled: account[0]?.twoFactorEnabled ?? false,
        passkeys: passkeys.map((entry) => ({
          id: entry.id,
          name: entry.name?.trim() || "Passkey",
          createdAt: entry.createdAt?.getTime() ?? null,
          synced: entry.deviceType === "multiDevice",
        })),
        sessions: activeSessions.map((entry) => ({
          id: entry.id,
          device: deviceLabel(entry.userAgent),
          mobile: /Mobile|Android|iPhone|iPad/.test(entry.userAgent ?? ""),
          ip: entry.ipAddress,
          lastActive: entry.updatedAt.getTime(),
          current: entry.id === session.id,
        })),
      };
    }),
  }),
  mcp: router({
    settings: protectedProcedure.query(async ({ ctx }) => {
      const config = readMcpConfig();
      return config.kind === "enabled"
        ? {
            kind: "enabled" as const,
            serverUrl: mcpResource(config.origin),
            connections: await listConnections(db, ctx.access.user.id),
          }
        : { kind: "unavailable" as const };
    }),
  }),
  libraries: librariesRouter,
  audit: router({
    list: protectedProcedure
      .input(
        z.object({
          action: auditFilter,
          actor: auditFilter,
          from: auditFilter,
          to: auditFilter,
          before: auditFilter,
        }),
      )
      .query(async ({ ctx, input }) => {
        if (!ctx.access.isAdmin)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only server administrators can open this page.",
          });
        const query = AuditQuery.fromSearchParams(input);
        const [page, accounts] = await Promise.all([
          listAuditEvents(db, query),
          db
            .select({ id: user.id, email: user.email })
            .from(user)
            .orderBy(asc(user.email)),
        ]);
        return {
          ...page,
          accounts,
          actions: auditActions,
          before: query.before ?? null,
        };
      }),
  }),
});

export const webRouter = t.mergeRouters(appRouter, webOnlyRouter);
export type WebRouter = typeof webRouter;

/** Calls the web router in-process, for data a page is sent with. */
export const createWebCaller = t.createCallerFactory(webRouter);
