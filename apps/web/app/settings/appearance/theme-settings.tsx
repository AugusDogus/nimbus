import { useRef, useState } from "react";
import { ColorScheme, useColorScheme } from "@/lib/color-scheme";
import { Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/alert-dialog";
import { CustomThemeStyles } from "@/components/custom-theme-styles";
import { useThemePreferences } from "@/lib/theme-store";
import { ColorThemeSync } from "@/lib/color-theme-sync";
import { ThemePreferences } from "@/lib/theme-preferences";
import { VsCodeTheme, type ThemeResult } from "@/lib/vscode-theme";
import { ThemeSearch } from "./theme-search";
import { AppearanceModes, ThemeLibrary } from "./theme-library";
import { IconThemeSettings } from "./icon-theme-settings";

type Confirmation = { type: "remove"; theme: VsCodeTheme } | { type: "reset" };

export function ThemeSettings() {
  const { scheme: mode, setScheme } = useColorScheme();
  const snapshot = useThemePreferences();
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const preferences =
    snapshot.status === "ready" ? snapshot.value : ThemePreferences.empty;
  const disabled = snapshot.status !== "ready" || reading;

  async function choose(appearance: "light" | "dark", id: string | null) {
    setError(null);
    const result = await ColorThemeSync.change({
      kind: "select",
      appearance,
      id,
    });
    if (!result.ok) setError(result.error);
  }

  /** Saves themes to the account, selecting one variant per appearance so System can use both. */
  async function install(
    themes: VsCodeTheme[],
  ): Promise<ThemeResult<ThemePreferences>> {
    const result = await ColorThemeSync.change({ kind: "install", themes });
    if (result.ok) setError(null);
    return result;
  }

  async function importFiles(files: File[]) {
    if (files.length === 0) return;
    setReading(true);
    setError(null);
    try {
      if (files.length > 40) {
        setError("Import up to 40 theme files at a time.");
        return;
      }
      const themes: VsCodeTheme[] = [];
      for (const file of files) {
        if (file.size > VsCodeTheme.maxBytes) {
          setError(
            `${file.name} is larger than 1 MB. Choose a smaller theme file.`,
          );
          return;
        }
        const result = VsCodeTheme.parse(await file.text(), file.name);
        if (!result.ok) {
          setError(`${file.name}: ${result.error}`);
          return;
        }
        themes.push(result.value);
      }
      const result = await install(themes);
      if (!result.ok) setError(result.error);
      else setAdding(false);
    } catch {
      setError(
        "The theme file could not be read. Select the file again. Your saved themes are unchanged.",
      );
    } finally {
      setReading(false);
    }
  }

  async function confirm() {
    const result =
      confirmation?.type === "reset"
        ? await ColorThemeSync.change({ kind: "reset" })
        : confirmation?.type === "remove"
          ? await ColorThemeSync.change({
              kind: "remove",
              id: confirmation.theme.id,
            })
          : null;
    if (result && !result.ok) setError(result.error);
    else {
      setError(null);
      setConfirmation(null);
    }
  }

  return (
    <section aria-labelledby="appearance-heading" className="space-y-6">
      {/* Applies choices at once; the app-wide copy may still be loading. */}
      <CustomThemeStyles />
      <h1
        id="appearance-heading"
        className="text-balance text-2xl font-semibold"
      >
        Appearance
      </h1>
      <AppearanceModes
        mode={mode}
        preferences={preferences}
        onChange={(next) => setScheme(ColorScheme.parse(next))}
        disabled={disabled}
      />
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-balance text-sm font-medium text-muted-foreground">
            Themes
          </h3>
          <Button
            variant="tertiary"
            size="compact"
            disabled={disabled}
            onClick={() => {
              setError(null);
              setAdding(true);
            }}
            leadingIcon={Plus}
          >
            Add theme
          </Button>
        </div>
        <ThemeLibrary
          preferences={preferences}
          onChoose={(appearance, id) => void choose(appearance, id)}
          onRemove={(theme) => {
            setError(null);
            setConfirmation({ type: "remove", theme });
          }}
          disabled={disabled}
        />
      </div>
      <IconThemeSettings />
      <input
        ref={input}
        type="file"
        accept=".json,.jsonc,application/json"
        multiple
        className="hidden"
        aria-label="Import VS Code theme files"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          void importFiles(files);
        }}
      />
      {((error && !adding) || snapshot.status === "error") && (
        <div className="space-y-2">
          <p role="alert" className="text-pretty text-sm text-destructive">
            {error ?? (snapshot.status === "error" ? snapshot.error : null)}
          </p>
          {snapshot.status === "error" && (
            <Button
              variant="tertiary"
              onClick={() => {
                setError(null);
                setConfirmation({ type: "reset" });
              }}
            >
              Reset saved themes
            </Button>
          )}
        </div>
      )}
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (!reading) setAdding(open);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add theme</DialogTitle>
            <DialogDescription>
              Import a VS Code theme or find one on Open VSX. Themes are saved
              to your account and follow you to every device.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Theme files</p>
              <p className="text-xs text-muted-foreground">
                VS Code JSON or JSONC, up to 1 MB each.
              </p>
            </div>
            <Button
              variant="tertiary"
              size="compact"
              disabled={disabled}
              onClick={() => input.current?.click()}
              leadingIcon={Upload}
            >
              {reading ? "Importing…" : "Import VS Code theme"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-pretty text-sm text-destructive">
              {error}
            </p>
          )}
          <ThemeSearch
            onInstall={async (themes) => {
              const result = await install(themes);
              if (result.ok) setAdding(false);
              return result;
            }}
            disabled={disabled}
          />
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              {confirmation?.type === "remove"
                ? `Remove ${confirmation.theme.name}?`
                : "Reset saved themes?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              {confirmation?.type === "remove"
                ? "Nimbus will use its default palette instead. You can import this theme again later. Your files are unchanged."
                : "This removes all imported themes from your account and restores Nimbus’s default palettes. Your files are unchanged."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-pretty text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void confirm();
              }}
            >
              {confirmation?.type === "remove"
                ? "Remove theme"
                : "Reset themes"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
