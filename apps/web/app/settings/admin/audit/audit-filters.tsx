import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { FieldLabel } from "@/components/ui/field";

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
  const navigate = useNavigate();
  const pending = useRouterState({
    select: (state) => state.status === "pending",
  });
  const actionItems = [{ value: any, label: "All events" }, ...actions];
  const accountItems = [
    { value: any, label: "Everyone" },
    ...accounts.map((account) => ({ value: account.id, label: account.email })),
  ];
  const apply = (next: Filters) =>
    void navigate({
      to: "/settings/admin/audit",
      search: next,
      replace: true,
    });
  const filtered = Object.values(value).some(Boolean);
  return (
    <form
      aria-label="Filter events"
      aria-busy={pending}
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="space-y-2">
        <FieldLabel htmlFor="audit-action">Event</FieldLabel>
        <Select
          value={value.action || any}
          onValueChange={(action) =>
            apply({ ...value, action: action === any ? "" : (action ?? "") })
          }
        >
          <SelectTrigger id="audit-action" className="w-full" />
          <SelectContent>
            {actionItems.map((action, index) => (
              <SelectItem index={index} key={action.value} value={action.value}>
                {action.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <FieldLabel htmlFor="audit-actor">Account</FieldLabel>
        <Select
          value={value.actor || any}
          onValueChange={(actor) =>
            apply({ ...value, actor: actor === any ? "" : (actor ?? "") })
          }
        >
          <SelectTrigger id="audit-actor" className="w-full" />
          <SelectContent>
            {accountItems.map((account, index) => (
              <SelectItem
                index={index}
                key={account.value}
                value={account.value}
              >
                {account.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <FieldLabel htmlFor="audit-from">From (UTC)</FieldLabel>
        <Input
          id="audit-from"
          type="date"
          value={value.from}
          onChange={(event) => apply({ ...value, from: event.target.value })}
          className="bg-background"
        />
      </div>
      <div className="space-y-2">
        <FieldLabel htmlFor="audit-to">To (UTC)</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="audit-to"
            type="date"
            value={value.to}
            onChange={(event) => apply({ ...value, to: event.target.value })}
            className="min-w-0 bg-background"
          />
          {filtered && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => apply({ action: "", actor: "", from: "", to: "" })}
            >
              Clear
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
