import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CodeLanguage } from "@/lib/file-kind";
import { EditLimits } from "@/lib/edit-limits";
import { saveText } from "./save-text";

/** The text an edit started from, with the ETag that identifies that version. */
export type EditBase = { text: string; etag: string };

type Status =
  | { type: "idle" }
  | { type: "saving" }
  | { type: "conflict" }
  | { type: "failed"; message: string };

export default function TextEditor({
  path,
  base: initialBase,
  onSaved,
  onClose,
  onDiscard,
  onDirtyChange,
}: {
  /** The file's path, for saving. */
  path: string;
  base: EditBase;
  language?: CodeLanguage;
  /** Called after each successful save with the text and version now on the server. */
  onSaved: (saved: EditBase & { size: number }) => void;
  /** Leaves the editor, after a save with nothing typed since or on cancel. */
  onClose: () => void;
  /** Leaves the editor after a conflict, showing the file as it is now. */
  onDiscard: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [base, setBase] = useState(initialBase);
  const [text, setText] = useState(initialBase.text);
  // Read after an await, where the rendered `text` would be stale.
  const latest = useRef(text);
  const dirty = text !== base.text;
  useEffect(() => {
    onDirtyChange?.(dirty);
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty, onDirtyChange]);
  const [status, setStatus] = useState<Status>({ type: "idle" });
  const saving = status.type === "saving";

  /** `etag` is the version the save may replace: the edit's base, or `*` to overwrite. */
  const save = async (etag: string) => {
    const submitted = text;
    // The server refuses larger edits; say so without sending megabytes for nothing.
    if (new TextEncoder().encode(submitted).byteLength > EditLimits.save)
      return setStatus({ type: "failed", message: EditLimits.tooLarge() });
    setStatus({ type: "saving" });
    const outcome = await saveText(path, etag, submitted);
    if (outcome.type === "conflict") return setStatus({ type: "conflict" });
    if (outcome.type === "failed")
      return setStatus({ type: "failed", message: outcome.message });
    setStatus({ type: "idle" });
    const saved = { text: submitted, etag: outcome.etag };
    setBase(saved);
    onSaved({ ...saved, size: outcome.size });
    // Text typed during the save stays in the editor, unsaved.
    if (latest.current === submitted) {
      onDirtyChange?.(false);
      onClose();
    }
  };

  return (
    <form
      className="space-y-2"
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) void save(base.etag);
      }}
    >
      <textarea
        aria-label="File contents"
        // Edit, which opened the editor, is gone; typing goes straight into the text.
        autoFocus
        value={text}
        onChange={(event) => {
          latest.current = event.target.value;
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className="h-[min(60dvh,32rem)] w-full resize-none rounded-md border bg-muted p-4 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      {status.type === "conflict" && (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive/50 p-3 text-sm"
        >
          <p className="text-pretty">
            This file changed after you started editing, so your edits were not
            saved. They are still here. Overwrite the file with them (its
            current text is kept in the version history), or discard them to see
            the current text.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onDiscard}>
              Discard my edits
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void save("*")}
            >
              Overwrite with my edits
            </Button>
          </div>
        </div>
      )}
      {status.type === "failed" && (
        <p role="alert" className="text-pretty text-sm text-destructive">
          {status.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
