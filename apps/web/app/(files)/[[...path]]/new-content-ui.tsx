"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import type { NewContentState } from "./use-new-content";

export function NewFolderDialog({ state }: { state: NewContentState }) {
  return (
    <Dialog
      open={state.folderDialogOpen}
      onOpenChange={state.setFolderDialogOpen}
    >
      <DialogContent>
        <form onSubmit={(event) => void state.handleCreateFolder(event)}>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Enter a name for the new folder
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              aria-label="Folder name"
              value={state.folderName}
              onChange={(e) => state.setFolderName(e.target.value)}
              placeholder="Untitled folder"
              autoFocus
              autoComplete="off"
              data-1p-ignore
            />
          </div>
          {state.folderError && (
            <p
              role="alert"
              className="mb-3 text-pretty text-sm text-destructive"
            >
              {state.folderError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => state.setFolderDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={state.creating || !state.folderName.trim()}
            >
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function HiddenFileInput({
  fileInputRef,
  handleFileChange,
}: Pick<NewContentState, "fileInputRef" | "handleFileChange">) {
  return (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      className="hidden"
      onChange={handleFileChange}
    />
  );
}
