"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { CodeLanguage } from "@/lib/file-kind";
import type { SaveOutcome } from "./save-text";

export default function TextEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  language?: CodeLanguage;
  onSave: (text: string) => Promise<SaveOutcome>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className="space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        const outcome = await onSave(text);
        setSaving(false);
        setProblem(outcome.type === "saved" ? null : outcome.message);
      }}
    >
      <textarea
        aria-label="File contents"
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className="h-[min(60dvh,32rem)] w-full resize-none rounded-md border bg-muted p-4 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      {problem && (
        <p role="alert" className="text-pretty text-sm text-destructive">
          {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={saving || text === initial}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
