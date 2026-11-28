import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { collectPicked, type CollectedUpload } from "@/lib/upload-sources";

type UseNewContentOptions = {
  /**
   * The folder New creates in from this page, or null where it has none (see `NewTarget`). A
   * menu, picker or dialog opened for one folder and still open after navigating to a page that
   * creates elsewhere, or nowhere, then does nothing.
   */
  target: string | null;
  onCreateFolder: (name: string) => Promise<void>;
  onUploadFiles: (upload: CollectedUpload) => void;
};

export type NewContentState = ReturnType<typeof useNewContent>;

export function useNewContent({
  target,
  onCreateFolder,
  onUploadFiles,
}: UseNewContentOptions) {
  // The folder the open dialog creates in; null while it is closed.
  const [folderDialogFor, setFolderDialogFor] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [creating, setCreating] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Handlers created before navigating read where the current page creates.
  const targetRef = useRef(target);
  useLayoutEffect(() => {
    targetRef.current = target;
  }, [target]);
  // The folder the file picker was opened for, if New opened it.
  const pickedFor = useRef<string | null>(null);
  // A New folder dialog left open by navigating to a page that creates elsewhere closes.
  if (folderDialogFor !== null && folderDialogFor !== target)
    setFolderDialogFor(null);
  const folderDialogOpen = folderDialogFor !== null;

  const setFolderDialogOpen = useCallback((open: boolean) => {
    if (!open) setFolderDialogFor(null);
  }, []);

  const openFolderDialog = useCallback(() => {
    if (targetRef.current === null) return;
    setFolderName("");
    setFolderError(null);
    setFolderDialogFor(targetRef.current);
  }, []);

  const handleCreateFolder = useCallback(
    async (e: React.SubmitEvent) => {
      e.preventDefault();
      if (folderDialogFor === null || folderDialogFor !== targetRef.current)
        return;
      if (!folderName.trim()) return;
      setCreating(true);
      setFolderError(null);
      try {
        await onCreateFolder(folderName.trim());
        setFolderDialogFor(null);
        setFolderName("");
      } catch (error) {
        setFolderError(
          error instanceof Error
            ? error.message
            : "The folder could not be created. Try again.",
        );
      } finally {
        setCreating(false);
      }
    },
    [folderDialogFor, folderName, onCreateFolder],
  );

  const triggerFileInput = useCallback(() => {
    if (targetRef.current === null) return;
    pickedFor.current = targetRef.current;
    fileInputRef.current?.click();
  }, []);

  // The folder picker is created on demand: React has no typed prop for its attribute, and one
  // file input on the page keeps the plain file picker unambiguous.
  const triggerFolderInput = useCallback(() => {
    const opened = targetRef.current;
    if (opened === null) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.addEventListener("change", () => {
      // A picker can stay open while the page changes behind it.
      if (opened === targetRef.current && input.files && input.files.length > 0)
        onUploadFiles(collectPicked(Array.from(input.files)));
    });
    input.click();
  }, [onUploadFiles]);

  // Both pickers report paths: folder pickers include the chosen folder in webkitRelativePath.
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        const opened = pickedFor.current;
        pickedFor.current = null;
        if (
          targetRef.current !== null &&
          (opened === null || opened === targetRef.current)
        )
          onUploadFiles(collectPicked(Array.from(e.target.files)));
        e.target.value = "";
      }
    },
    [onUploadFiles],
  );

  return {
    folderDialogOpen,
    setFolderDialogOpen,
    folderName,
    setFolderName,
    creating,
    folderError,
    fileInputRef,
    openFolderDialog,
    handleCreateFolder,
    triggerFileInput,
    triggerFolderInput,
    handleFileChange,
  };
}
