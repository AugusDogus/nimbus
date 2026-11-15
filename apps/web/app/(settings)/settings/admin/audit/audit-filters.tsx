"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Filters = { action: string; actor: string; from: string; to: string };
const any = "any";

export function AuditFilters({
  actions,
  accounts,
  value,
}: {
  actions: { value: string; label: string }[];
  accounts: { id: string; email: string }[];
  value: Filters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const apply = (next: Filters) => {
    const params = new URLSearchParams();
    for (const [key, entry] of Object.entries(next)) if (entry) params.set(key, entry);
    startTransition(() => router.replace(params.size ? `${pathname}?${params}` : pathname));
  };
  const filtered = Object.values(value).some(Boolean);
  return (
    <form
      aria-label="Filter events"
      aria-busy={pending}
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="space-y-2">
        <Label htmlFor="audit-action">Event</Label>
        <Select value={value.action || any} onValueChange={(action) => apply({ ...value, action: action === any ? "" : action })}>
          <SelectTrigger id="audit-action" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={any}>All events</SelectItem>
            {actions.map((action) => <SelectItem key={action.value} value={action.value}>{action.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="audit-actor">Account</Label>
        <Select value={value.actor || any} onValueChange={(actor) => apply({ ...value, actor: actor === any ? "" : actor })}>
          <SelectTrigger id="audit-actor" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={any}>Everyone</SelectItem>
            {accounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.email}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="audit-from">From (UTC)</Label>
        <Input id="audit-from" type="date" value={value.from} onChange={(event) => apply({ ...value, from: event.target.value })} className="bg-background" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="audit-to">To (UTC)</Label>
        <div className="flex gap-2">
          <Input id="audit-to" type="date" value={value.to} onChange={(event) => apply({ ...value, to: event.target.value })} className="min-w-0 bg-background" />
          {filtered && (
            <Button type="button" variant="ghost" onClick={() => apply({ action: "", actor: "", from: "", to: "" })}>
              Clear
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
