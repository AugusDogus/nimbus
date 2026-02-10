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
    <Dialog open={state.folderDialogOpen} onOpenChange={state.setFolderDialogOpen}>
      <DialogContent>
        <form onSubmit={state.handleCreateFolder}>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>Enter a name for the new folder</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={state.folderName}
              onChange={(e) => state.setFolderName(e.target.value)}
              placeholder="Untitled folder"
              autoFocus
              autoComplete="off"
              data-1p-ignore
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => state.setFolderDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={state.creating || !state.folderName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function HiddenFileInput({ state }: { state: NewContentState }) {
  return (
    <input
      ref={state.fileInputRef}
      type="file"
      multiple
      className="hidden"
      onChange={state.handleFileChange}
    />
  );
}
