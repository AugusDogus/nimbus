import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Download, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import { EntryIcon, FileIconsScope } from "@/app/drive/files/file-icons";
import { IconChoice } from "@/lib/icon-choice";
import { iconChoiceQuery } from "@/lib/icon-choice-query";
import { iconPreviewNames } from "@/lib/icon-themes";
import { queryClient, trpc, trpcClient } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { TRPCClientError } from "@trpc/client";
import { IconThemeSearch } from "./icon-theme-search";

type IconSet = {
  id: string;
  name: string;
  credit: string | null;
  homepage: string | null;
  licence: string | null;
  state: "ready" | "download" | "unavailable";
  manifest: string | null;
  problem: string | null;
  imported: boolean;
};

/** A row of sample entries drawn with `set`'s icons, or Nimbus's own before it downloads. */
function IconPreview({ manifest }: { manifest: string | null }) {
  return (
    <FileIconsScope manifest={manifest}>
      <span
        aria-hidden
        className="flex min-w-0 items-center gap-1.5 overflow-hidden sm:gap-2"
      >
        {iconPreviewNames.map((sample) => (
          <EntryIcon
            key={sample.name}
            type={sample.type}
            name={sample.name}
            className="size-6 shrink-0 text-muted-foreground"
          />
        ))}
      </span>
    </FileIconsScope>
  );
}

function IconSetCard({
  set,
  selected,
  busy,
  disabled,
  onChoose,
  actions,
}: {
  set: IconSet;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  onChoose: () => void;
  actions?: ReactNode;
}) {
  return (
    <article
      data-icon-set={set.id}
      className={cn(
        "relative min-w-0 rounded-xl border bg-card/60",
        selected ? "border-ring" : "border-border/70",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`Use ${set.name} file icons`}
        disabled={disabled || set.state === "unavailable"}
        onClick={onChoose}
        className="flex w-full cursor-pointer flex-col gap-3 rounded-xl p-3 text-left outline-none hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
      >
        <IconPreview manifest={set.state === "ready" ? set.manifest : null} />
        <span className="flex min-h-5 items-center gap-2 pr-9">
          <span className="truncate text-sm font-medium" title={set.name}>
            {set.name}
          </span>
          {selected && (
            <Check aria-hidden className="size-4 shrink-0 text-primary" />
          )}
        </span>
        <span className="pr-9 text-pretty text-xs text-muted-foreground">
          {busy
            ? "Downloading from Open VSX…"
            : set.state === "download"
              ? "Downloads from Open VSX when chosen."
              : set.state === "unavailable"
                ? set.problem
                : set.id === "lucide"
                  ? "Nimbus's own icons, tinted by type."
                  : "Nimbus's icons fill in types it lacks."}
        </span>
      </button>
      {set.state === "download" && !busy && (
        <Download
          aria-hidden
          className="pointer-events-none absolute right-3 top-3 size-4 text-muted-foreground"
        />
      )}
      {actions && (
        <div className="absolute bottom-1.5 right-1.5">{actions}</div>
      )}
    </article>
  );
}

const message = (error: unknown) =>
  error instanceof TRPCClientError
    ? error.message
    : "Nimbus could not reach the server. Check your connection and try again. Your icons are unchanged.";

export function IconThemeSettings() {
  const sets = useQuery(trpc.appearance.iconSets.queryOptions());
  const [choosing, setChoosing] = useState<string | null>(null);
  const choose = useMutation({
    mutationFn: (id: string) =>
      trpcClient.appearance.chooseIcons.mutate({ id }),
    onMutate: (id) => setChoosing(id),
    onSettled: () => setChoosing(null),
    onSuccess: (choice) => {
      const parsed = IconChoice.parse(choice);
      if (parsed) {
        queryClient.setQueryData(iconChoiceQuery.queryKey, parsed);
        IconChoice.cache(parsed);
      }
      void queryClient.invalidateQueries({
        queryKey: trpc.appearance.iconSets.queryKey(),
      });
    },
  });
  const chosen = choosing ?? sets.data?.chosen ?? null;
  const [adding, setAdding] = useState(false);
  // The set stays named while the dialog closes.
  const [removing, setRemoving] = useState<IconSet | null>(null);
  const [confirming, setConfirming] = useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.appearance.iconSets.queryKey(),
      }),
      queryClient.invalidateQueries({ queryKey: iconChoiceQuery.queryKey }),
    ]);
  const remove = useMutation({
    mutationFn: (id: string) =>
      trpcClient.appearance.removeIconSet.mutate({ id }),
    onSuccess: async () => {
      setConfirming(false);
      await refresh();
    },
  });
  const busy = choose.isPending || remove.isPending;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-balance text-sm font-medium text-muted-foreground">
          File icons
        </h3>
        <Button
          variant="tertiary"
          size="compact"
          disabled={busy}
          onClick={() => setAdding(true)}
          leadingIcon={Plus}
        >
          Add icon set
        </Button>
      </div>
      {sets.isPending ? (
        <div
          role="status"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
        >
          <span className="sr-only">Loading file icon sets…</span>
          {[0, 1, 2].map((key) => (
            <Skeleton
              key={key}
              className="h-28 rounded-xl motion-reduce:animate-none"
            />
          ))}
        </div>
      ) : sets.isError ? (
        <p role="alert" className="text-pretty text-sm text-destructive">
          {message(sets.error)}
        </p>
      ) : (
        <div
          role="group"
          aria-label="File icon sets"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
        >
          {sets.data.sets.map((set) => (
            <IconSetCard
              key={set.id}
              set={set}
              selected={chosen === set.id}
              busy={choose.isPending && choosing === set.id}
              disabled={busy}
              onChoose={() => choose.mutate(set.id)}
              actions={
                set.imported ? (
                  <Button
                    variant="ghost"
                    size="icon-compact"
                    className="text-muted-foreground"
                    disabled={busy}
                    aria-label={`Remove ${set.name}`}
                    title={`Remove ${set.name}`}
                    onClick={() => {
                      remove.reset();
                      setRemoving(set);
                      setConfirming(true);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : undefined
              }
            />
          ))}
        </div>
      )}
      {choose.isError && (
        <p role="alert" className="text-pretty text-sm text-destructive">
          {message(choose.error)}
        </p>
      )}
      <p className="text-pretty text-xs text-muted-foreground">
        Icons show wherever a file has no thumbnail. Your choice follows your
        account to every device.
      </p>
      {sets.data && (
        <ul className="space-y-1 text-pretty text-xs text-muted-foreground">
          {sets.data.sets
            .filter((set) => set.credit)
            .map((set) => (
              <li key={set.id}>
                {set.name}:{" "}
                {set.homepage ? (
                  <a
                    className="underline underline-offset-4"
                    href={set.homepage}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {set.credit}
                  </a>
                ) : (
                  set.credit
                )}
                {set.licence && (
                  <>
                    {" "}
                    (
                    <a
                      className="underline underline-offset-4"
                      href={set.licence}
                      target="_blank"
                      rel="noreferrer"
                    >
                      licence text
                    </a>
                    )
                  </>
                )}
              </li>
            ))}
        </ul>
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add icon set</DialogTitle>
            <DialogDescription>
              Import a file icon theme from Open VSX for your account.
            </DialogDescription>
          </DialogHeader>
          <IconThemeSearch disabled={busy} onImported={() => void refresh()} />
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setConfirming(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-balance">
              Remove {removing?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              Its icons are deleted from the server. If you use it, Nimbus
              switches to Material+. You can import it again later. Your files
              are unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {remove.isError && (
            <p role="alert" className="text-pretty text-sm text-destructive">
              {message(remove.error)}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={() => {
                if (removing) remove.mutate(removing.id);
              }}
            >
              Remove icon set
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
