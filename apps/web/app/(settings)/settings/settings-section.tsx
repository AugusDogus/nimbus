import type { ReactNode } from "react";

export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="space-y-1">
          <h2 className="text-balance text-sm font-medium">{title}</h2>
          {description && (
            <p className="max-w-prose text-pretty text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className="divide-y divide-border/50 rounded-2xl border border-border/60 bg-card/40">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid items-center gap-3 px-4 py-4 sm:grid-cols-2 sm:gap-8 sm:px-5">
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <p className="max-w-prose text-pretty text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="w-full min-w-0 sm:max-w-md sm:justify-self-end">
        {children}
      </div>
    </div>
  );
}
