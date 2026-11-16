"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UploadPlan } from "@/lib/upload-plan";
import type { ClashPrompt } from "@/lib/use-upload-queue";

/** Asks what to do with an upload whose name is taken: replace, keep both, or skip. */
export function UploadConflictDialog({
  prompt,
}: {
  prompt: ClashPrompt | null;
}) {
  const [all, setAll] = useState(false);
  const checkboxId = useId();
  if (!prompt) return null;
  const { clash, remaining } = prompt;
  const replaceable = UploadPlan.canReplace(clash);
  const folder = clash.kind === "dir";
  const choose = (choice: "replace" | "keep-both" | "skip") => {
    prompt.resolve(choice, all);
    setAll(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          setAll(false);
          prompt.cancel();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-balance">
            {folder ? "A folder" : "A file"} named “{clash.name}” already exists
          </DialogTitle>
          <DialogDescription className="text-pretty">
            {!replaceable
              ? `It is ${clash.existing === "dir" ? "a folder" : "a file"}, so it cannot be replaced. Keep both to upload under a numbered name.`
              : folder
                ? `Replacing merges ${clash.files === 1 ? "the uploaded file" : `the ${clash.files.toLocaleString()} uploaded files`} into it and overwrites files with the same names. Keep both uploads a separate numbered folder.`
                : "Replacing overwrites its contents. Keep both uploads the new file under a numbered name."}
          </DialogDescription>
        </DialogHeader>
        {remaining > 0 && (
          <label
            htmlFor={checkboxId}
            className="flex items-center gap-2 text-sm"
          >
            <Checkbox id={checkboxId} checked={all} onCheckedChange={setAll} />
            Apply to all {(remaining + 1).toLocaleString()} name clashes
          </label>
        )}
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => choose("skip")}>
            Skip
          </Button>
          <Button variant="outline" onClick={() => choose("keep-both")}>
            Keep both
          </Button>
          {replaceable && (
            <Button onClick={() => choose("replace")}>Replace</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
