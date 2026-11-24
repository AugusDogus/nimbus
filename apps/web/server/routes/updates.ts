import { auditUser, recordAudit, type AuditAction } from "@nimbus/api/audit";
import { z } from "zod";
import { allowedOrigins } from "@/lib/auth";
import { httpError, requestAccess } from "@/server/http-files";
import { RequestOrigin } from "@/server/request-origin";
import { UpdateRequests } from "@/server/updates/update-requests";
import type { HandoverEvent } from "@/server/supervisor/handover-stream";

/**
 * The administration page's updates (see docs/updates.md, Updates from Settings), for server
 * administrators signed in with a session, never a paired device or an app password. Each asks
 * the supervisor one of its closed set of requests; none names a release, a path or a URL.
 *
 * - GET: what the page shows.
 * - POST `{ action: "check" }`, `{ action: "schedule", mode, hour }`: that, then what the page
 *   shows.
 * - POST `{ action: "install" | "rollback" }`: the handover's events as it goes, one JSON object
 *   per line, `done` last (HandoverStream).
 */
const noStore = { "Cache-Control": "no-store" };

const body = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("check") }),
  z.strictObject({ action: z.literal("install") }),
  z.strictObject({ action: z.literal("rollback") }),
  z.strictObject({
    action: z.literal("schedule"),
    mode: z.enum(["off", "notify", "install"]),
    hour: z.number().int().min(0).max(23),
  }),
]);

const unavailable = (error: string) =>
  Response.json({ error }, { status: 503, headers: noStore });

export async function GET(request: Request) {
  try {
    (await requestAccess(request)).requireAdmin();
    const channel = UpdateRequests.channel();
    if (!channel) return unavailable(UpdateRequests.standalone);
    const answer = await channel.ask({ kind: "status" });
    return answer.ok
      ? Response.json({ panel: answer.panel }, { headers: noStore })
      : unavailable(answer.message);
  } catch (error) {
    return httpError(error);
  }
}

export async function POST(request: Request) {
  // The session cookie is SameSite=Lax, so check that a Nimbus page sent this.
  if (!RequestOrigin.fromNimbus(request, allowedOrigins))
    return Response.json(
      {
        error:
          "This request did not come from Nimbus Settings, so nothing was changed. Use Updates in Settings, Administration.",
      },
      { status: 403, headers: noStore },
    );
  try {
    const access = await requestAccess(request);
    access.requireAdmin();
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      value = null;
    }
    const parsed = body.safeParse(value);
    if (!parsed.success)
      return Response.json(
        {
          error:
            "The request was not one Updates sends, so nothing was changed. Reload the page and try again.",
        },
        { status: 400, headers: noStore },
      );
    const channel = UpdateRequests.channel();
    if (!channel) return unavailable(UpdateRequests.standalone);
    const asked = parsed.data;
    const actor = auditUser(access.user);
    if (asked.action === "check" || asked.action === "schedule") {
      const answer = await channel.ask(
        asked.action === "check"
          ? { kind: "check" }
          : { kind: "schedule", mode: asked.mode, hour: asked.hour },
      );
      if (answer.ok && asked.action === "schedule")
        recordAudit({
          action: "setting.changed",
          actor,
          target: { type: "setting", id: "updates.schedule" },
          details: { mode: asked.mode, hour: asked.hour },
        });
      return answer.ok
        ? Response.json({ panel: answer.panel }, { headers: noStore })
        : Response.json(
            { error: answer.message },
            { status: 409, headers: noStore },
          );
    }
    const kind = asked.action;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true;
        const line = (event: HandoverEvent) => {
          if (open)
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        const done = await channel.act({ kind }, line);
        const outcome: HandoverEvent = done ?? {
          kind: "done",
          ok: false,
          error: {
            kind: "update-failed",
            message:
              "The supervisor went away before it said how this ended. Reload the page to see what runs now.",
          },
        };
        if (!done) line(outcome);
        if (outcome.kind === "done") {
          const action: AuditAction =
            kind === "install"
              ? outcome.ok
                ? "update.installed"
                : "update.install_failed"
              : outcome.ok
                ? "update.rolled_back"
                : "update.rollback_failed";
          // A request refused as busy, or one the page asked twice, is not an update.
          if (outcome.ok || outcome.error.kind !== "busy")
            recordAudit({
              action,
              actor,
              target: {
                type: "release",
                id: outcome.ok ? outcome.report.to : "unchanged",
              },
              details: outcome.ok
                ? { from: outcome.report.from, to: outcome.report.to }
                : { message: outcome.error.message.slice(0, 500) },
            });
        }
        open = false;
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson", ...noStore },
    });
  } catch (error) {
    return httpError(error);
  }
}
