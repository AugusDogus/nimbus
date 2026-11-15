import Link from "next/link";
import { ScrollText } from "lucide-react";
import { asc } from "drizzle-orm";
import { auditActions, type AuditAction } from "@nimbus/api/audit";
import { Button } from "@/components/ui/button";
import { getCaller } from "@/server/files-data";
import { AuditQuery, listAuditEvents } from "@/server/audit-log";
import { db } from "@/server/db";
import { user } from "@/server/db/schema";
import { SettingsSection } from "../../settings-section";
import { auditLabels } from "./audit-labels";
import { AuditFilters } from "./audit-filters";

const isAction = (value: string): value is AuditAction => auditActions.some((action) => action === value);
const failures = new Set<string>(["auth.sign_in_failed", "auth.rate_limited", "share.password_failed", "webdav.auth_failed"]);

function describeDetails(details: Record<string, string | number | boolean | null> | null) {
  if (!details) return null;
  const parts: string[] = [];
  if (typeof details.method === "string") parts.push(details.method.replaceAll("+", " + ").replaceAll("_", " "));
  if (typeof details.reason === "string") parts.push(details.reason.replaceAll("_", " ").toLowerCase());
  if (typeof details.permission === "string") parts.push(`${details.permission} permission`);
  if (typeof details.role === "string") parts.push(`role ${details.role}`);
  if (typeof details.service === "string") parts.push(details.service);
  return parts.length ? parts.join(" · ") : null;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await (await getCaller()).access.me();
  if (!me.isAdmin) return <p role="alert">Only server administrators can open this page.</p>;
  const params = await searchParams;
  const query = AuditQuery.fromSearchParams(params);
  const [page, accounts] = await Promise.all([
    listAuditEvents(db, query),
    db.select({ id: user.id, email: user.email }).from(user).orderBy(asc(user.email)),
  ]);
  const nextHref = (() => {
    if (page.next === undefined) return null;
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (typeof value === "string" && key !== "before") next.set(key, value);
    next.set("before", String(page.next));
    return `?${next}`;
  })();
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-balance text-2xl font-semibold">Audit log</h1>
        <p className="max-w-prose text-pretty text-sm text-muted-foreground">
          Sign-ins, account changes, sharing and deletions on this server. Entries cannot be edited and are kept for the configured retention period.
        </p>
      </div>
      <AuditFilters
        actions={auditActions.map((action) => ({ value: action, label: auditLabels[action] }))}
        accounts={accounts}
        value={{
          action: query.action ?? "",
          actor: query.actorId ?? "",
          from: typeof params.from === "string" ? params.from : "",
          to: typeof params.to === "string" ? params.to : "",
        }}
      />
      <SettingsSection title="Events">
        {page.events.length === 0 ? (
          <div className="flex items-start gap-4 p-5 sm:py-8">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background">
              <ScrollText className="size-4 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No matching events</p>
              <p className="max-w-prose text-pretty text-sm text-muted-foreground">
                Change the filters, or check back after people sign in and share files.
              </p>
            </div>
          </div>
        ) : (
          <ol aria-label="Audit events" className="divide-y divide-border/50">
            {page.events.map((event) => {
              const label = isAction(event.action) ? auditLabels[event.action] : event.action;
              const detail = describeDetails(event.details);
              const actor = event.actorType === "system" ? "Nimbus" : (event.actorLabel ?? "Anonymous");
              return (
                <li key={event.id} className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4 sm:px-5">
                  <time
                    className="text-xs tabular-nums text-muted-foreground sm:pt-0.5"
                    dateTime={new Date(event.at).toISOString()}
                  >
                    {new Date(event.at).toISOString().replace("T", " ").slice(0, 19)} UTC
                  </time>
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm">
                      <span className={failures.has(event.action) ? "font-medium text-destructive" : "font-medium"}>{label}</span>
                      {event.targetLabel || event.targetId ? (
                        <span className="break-all text-muted-foreground"> · {event.targetLabel ?? event.targetId}</span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {actor}
                      {event.ip && <span className="tabular-nums"> · {event.ip}</span>}
                      {detail && <span> · {detail}</span>}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </SettingsSection>
      {(nextHref || query.before !== undefined) && (
        <div className="flex justify-end gap-2">
          {query.before !== undefined && (
            <Button asChild variant="outline" size="sm">
              <Link href={`?${new URLSearchParams(Object.entries(params).flatMap(([key, value]) => (typeof value === "string" && key !== "before" ? [[key, value]] : [])))}`}>
                Newest
              </Link>
            </Button>
          )}
          {nextHref && (
            <Button asChild variant="outline" size="sm">
              <Link href={nextHref}>Older</Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
