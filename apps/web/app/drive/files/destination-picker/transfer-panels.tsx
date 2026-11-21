import { AlertCircle, CopyPlus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TransferClash, TransferResult } from "../transfer-result";

/** Items listed by name before the rest are counted. */
const shown = 5;

function Names({ names }: { names: readonly string[] }) {
  const rest = names.length - shown;
  return (
    <ul className="space-y-1 text-sm">
      {names.slice(0, shown).map((name) => (
        <li key={name} className="truncate" title={name}>
          {name}
        </li>
      ))}
      {rest > 0 && (
        <li className="text-muted-foreground">
          and {rest.toLocaleString()} more
        </li>
      )}
    </ul>
  );
}

export type ClashChoice =
  | { kind: "keep-both" }
  | { kind: "rename"; name: string }
  | { kind: "skip" }
  | { kind: "cancel" };

/**
 * Items whose names are taken in the destination, and what to do: give one item a new name,
 * keep both under numbered names, leave them where they are (when there are several), or stop.
 * Nothing is ever replaced.
 */
export function ClashPanel({
  clashes,
  place,
  busy,
  onChoose,
}: {
  clashes: readonly TransferClash[];
  /** The destination's name as the person sees it. */
  place: string;
  busy: boolean;
  onChoose: (choice: ClashChoice) => void;
}) {
  const [only] = clashes;
  const single = clashes.length === 1 && only ? only : null;
  const [name, setName] = useState(single?.suggestion ?? "");
  const inputId = useId();
  const trimmed = name.trim();
  // The choice is what the person is asked for, so it takes focus.
  const nameInput = useRef<HTMLInputElement>(null);
  const keepBoth = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (nameInput.current ?? keepBoth.current)?.focus();
  }, []);
  return (
    <div
      role="alertdialog"
      aria-labelledby={`${inputId}-title`}
      className="space-y-4 p-4"
    >
      <div className="flex gap-3">
        <CopyPlus
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-primary"
        />
        <div className="min-w-0 space-y-2">
          <h3 id={`${inputId}-title`} className="text-pretty font-medium">
            {single
              ? `“${single.name}” is already in ${place}`
              : `${clashes.length.toLocaleString()} items have names already in ${place}`}
          </h3>
          <p className="text-pretty text-sm text-muted-foreground">
            Nothing has been replaced. Choose what to do with{" "}
            {single ? "this item" : "these items"}.
          </p>
          {!single && <Names names={clashes.map((clash) => clash.name)} />}
        </div>
      </div>
      {single && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed) onChoose({ kind: "rename", name: trimmed });
          }}
        >
          <Label htmlFor={inputId}>New name</Label>
          <div className="flex gap-2">
            <Input
              ref={nameInput}
              id={inputId}
              value={name}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              className="min-w-0"
            />
            <Button type="submit" disabled={busy || !trimmed}>
              Rename
            </Button>
          </div>
        </form>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          ref={keepBoth}
          variant={single ? "outline" : "default"}
          disabled={busy}
          onClick={() => onChoose({ kind: "keep-both" })}
        >
          Keep both
        </Button>
        {!single && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onChoose({ kind: "skip" })}
          >
            Skip {clashes.length === 1 ? "it" : "these"}
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => onChoose({ kind: "cancel" })}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** What Undo of the items that did arrive reported. */
export type UndoSummary = { ok: boolean; message: string };

/**
 * What a transfer could not do, kept in view so the failed items can be tried again, with Undo
 * for those that did arrive: the toast that reports them sits behind the picker meanwhile.
 * It takes focus when it appears, as the button that started the transfer is disabled.
 */
export function FailurePanel({
  result,
  place,
  busy,
  onRetry,
  onUndo,
}: {
  result: TransferResult;
  /** The destination's name as the person sees it. */
  place: string;
  busy: boolean;
  onRetry: () => void;
  onUndo: () => Promise<UndoSummary>;
}) {
  const verb = result.operation === "move" ? "moved" : "copied";
  const failed = result.failed.length;
  const done = result.transferred.length;
  const reasons = [...new Set(result.failed.map((failure) => failure.reason))];
  const [first] = result.failed;
  const heading = done
    ? `${result.operation === "move" ? "Moved" : "Copied"} ${done.toLocaleString()} of ${(done + failed).toLocaleString()} items to ${place}. ${failed.toLocaleString()} could not be ${verb}:`
    : failed === 1 && first
      ? `“${first.source.name}” was not ${verb}:`
      : `None of the ${failed.toLocaleString()} items were ${verb}:`;
  const [undo, setUndo] = useState<
    | { kind: "offered" }
    | { kind: "undoing" }
    | { kind: "done"; summary: UndoSummary }
  >({ kind: "offered" });
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);
  return (
    <div
      ref={panel}
      role="alert"
      tabIndex={-1}
      className="space-y-3 border-b bg-destructive/5 p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex gap-3">
        <AlertCircle
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-destructive"
        />
        <div className="min-w-0 space-y-2">
          <p className="text-pretty text-sm font-medium">{heading}</p>
          <ul className="space-y-1 text-pretty text-sm text-muted-foreground">
            {reasons.slice(0, 3).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <Names names={result.failed.map((failure) => failure.source.name)} />
          <p className="text-pretty text-sm text-muted-foreground">
            Try again, or choose another folder for{" "}
            {failed === 1 ? "it" : "them"}.
          </p>
          {undo.kind === "done" && (
            <p
              role="status"
              className={cn(
                "text-pretty text-sm",
                undo.summary.ok ? "text-foreground" : "text-destructive",
              )}
            >
              {undo.summary.message}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={onRetry}>
          Try again
        </Button>
        {done > 0 && undo.kind !== "done" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || undo.kind === "undoing"}
            onClick={() => {
              setUndo({ kind: "undoing" });
              void onUndo().then((summary) =>
                setUndo({ kind: "done", summary }),
              );
            }}
          >
            Undo
          </Button>
        )}
      </div>
    </div>
  );
}
