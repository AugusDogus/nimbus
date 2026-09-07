"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ThemePreferences } from "@/lib/theme-preferences";
import type { VsCodeTheme } from "@/lib/vscode-theme";

type PreviewColors = Pick<
  VsCodeTheme["colors"],
  "background" | "sidebar" | "foreground" | "primary" | "border"
>;
const defaultPreviews: Record<"light" | "dark", PreviewColors> = {
  light: {
    background: "#f7f8fa",
    sidebar: "#eef0f4",
    foreground: "#242731",
    primary: "#426699",
    border: "#dce0e7",
  },
  dark: {
    background: "#222429",
    sidebar: "#1d1f23",
    foreground: "#e8e9ed",
    primary: "#b8cdf4",
    border: "#363940",
  },
};

function Preview({ colors }: { colors: PreviewColors }) {
  return (
    <div
      aria-hidden="true"
      className="flex h-16 min-w-0 flex-1 overflow-hidden rounded-md border"
      style={{ backgroundColor: colors.background, borderColor: colors.border }}
    >
      <div
        className="w-1/4 space-y-1.5 p-2"
        style={{ backgroundColor: colors.sidebar }}
      >
        <div
          className="h-1.5 rounded-sm"
          style={{ backgroundColor: colors.primary }}
        />
        <div
          className="h-1 rounded-sm opacity-40"
          style={{ backgroundColor: colors.foreground }}
        />
        <div
          className="h-1 rounded-sm opacity-40"
          style={{ backgroundColor: colors.foreground }}
        />
      </div>
      <div className="flex-1 space-y-2 p-2">
        <div
          className="h-1.5 w-1/2 rounded-sm"
          style={{ backgroundColor: colors.foreground }}
        />
        <div
          className="h-1 rounded-sm opacity-40"
          style={{ backgroundColor: colors.foreground }}
        />
        <div
          className="h-1 w-2/3 rounded-sm opacity-40"
          style={{ backgroundColor: colors.foreground }}
        />
      </div>
    </div>
  );
}

export function AppearanceModes({
  mode,
  preferences,
  onChange,
  disabled,
}: {
  mode: string;
  preferences: ThemePreferences;
  onChange: (mode: string) => void;
  disabled: boolean;
}) {
  const colors = (appearance: "light" | "dark") =>
    preferences.themes.find((theme) => theme.id === preferences[appearance])
      ?.colors ?? defaultPreviews[appearance];
  return (
    <div className="space-y-2">
      <h3 className="text-balance text-sm font-medium">Color scheme</h3>
      <div
        role="group"
        aria-label="Appearance mode"
        className="grid grid-cols-3 gap-2"
      >
        {(["system", "light", "dark"] as const).map((appearance) => (
          <Button
            key={appearance}
            variant="outline"
            disabled={disabled}
            className={cn(
              "h-auto min-w-0 flex-col items-stretch gap-2 p-2",
              mode === appearance && "border-ring ring-1 ring-ring",
            )}
            aria-label={
              appearance === "system"
                ? "Follow the system appearance"
                : `Use ${appearance} mode`
            }
            aria-pressed={mode === appearance}
            onClick={() => onChange(appearance)}
          >
            <div className="flex min-w-0 gap-0.5">
              {appearance === "system" ? (
                <>
                  <Preview colors={colors("light")} />
                  <Preview colors={colors("dark")} />
                </>
              ) : (
                <Preview colors={colors(appearance)} />
              )}
            </div>
            <span>
              {appearance === "system"
                ? "System"
                : appearance === "light"
                  ? "Light"
                  : "Dark"}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}

export function ThemeLibrary({
  preferences,
  onChoose,
  onRemove,
  disabled,
}: {
  preferences: ThemePreferences;
  onChoose: (appearance: "light" | "dark", id: string | null) => void;
  onRemove: (theme: VsCodeTheme) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <article className="space-y-3 rounded-lg border p-3">
        <h4 className="text-balance text-sm font-medium">Nimbus</h4>
        <div className="grid grid-cols-2 gap-2">
          {(["light", "dark"] as const).map((mode) => (
            <Button
              key={mode}
              variant="outline"
              disabled={disabled}
              className={cn(
                "h-auto min-w-0 flex-col items-stretch gap-2 p-2",
                preferences[mode] === null && "border-ring",
              )}
              aria-label={`Use Nimbus for ${mode} mode`}
              aria-pressed={preferences[mode] === null}
              onClick={() => onChoose(mode, null)}
            >
              <Preview colors={defaultPreviews[mode]} />
              <span>{mode === "light" ? "Light" : "Dark"}</span>
            </Button>
          ))}
        </div>
      </article>
      {preferences.themes.map((theme) => (
        <article
          key={theme.id}
          className="flex min-w-0 flex-col gap-2 rounded-lg border p-3"
        >
          <Button
            variant="ghost"
            disabled={disabled}
            className="h-auto min-w-0 flex-1 flex-col items-stretch gap-3 p-0 hover:bg-transparent"
            aria-label={`Use ${theme.name} for ${theme.appearance} mode`}
            aria-pressed={preferences[theme.appearance] === theme.id}
            onClick={() => onChoose(theme.appearance, theme.id)}
          >
            <span className="truncate text-left text-sm font-medium">
              {theme.name}
            </span>
            <Preview colors={theme.colors} />
            <span className="text-left text-xs text-muted-foreground">
              {preferences[theme.appearance] === theme.id
                ? `Selected for ${theme.appearance} mode`
                : `Use for ${theme.appearance} mode`}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="self-end"
            disabled={disabled}
            aria-label={`Remove ${theme.name}`}
            onClick={() => onRemove(theme)}
          >
            Remove
          </Button>
        </article>
      ))}
    </div>
  );
}
