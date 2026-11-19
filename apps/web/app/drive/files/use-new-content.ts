import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { collectPicked, type CollectedUpload } from "@/lib/upload-sources";

type UseNewContentOptions = {
  /**
   * Whether this page can create here. Trash and a missing folder cannot: a menu, picker or
   * dialog opened on another page and still open after navigating there then does nothing.
   */
  available: boolean;
  onCreateFolder: (name: string) => Promise<void>;
  onUploadFiles: (upload: CollectedUpload) => void;
};

export type NewContentState = ReturnType<typeof useNewContent>;

export function useNewContent({
  available,
  onCreateFolder,
  onUploadFiles,
}: UseNewContentOptions) {
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [creating, setCreating] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Handlers created before navigating read whether the current page can still create.
  const availableRef = useRef(available);
  useLayoutEffect(() => {
    availableRef.current = available;
  }, [available]);
  // A New folder dialog left open by navigating to such a page closes.
  if (!available && folderDialogOpen) setFolderDialogOpen(false);

  const openFolderDialog = useCallback(() => {
    if (!availableRef.current) return;
    setFolderName("");
    setFolderError(null);
    setFolderDialogOpen(true);
  }, []);

  const handleCreateFolder = useCallback(
    async (e: React.SubmitEvent) => {
      e.preventDefault();
      if (!availableRef.current || !folderName.trim()) return;
      setCreating(true);
      setFolderError(null);
      try {
        await onCreateFolder(folderName.trim());
        setFolderDialogOpen(false);
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
    [folderName, onCreateFolder],
  );

  const triggerFileInput = useCallback(() => {
    if (availableRef.current) fileInputRef.current?.click();
  }, []);

  // The folder picker is created on demand: React has no typed prop for its attribute, and one
  // file input on the page keeps the plain file picker unambiguous.
  const triggerFolderInput = useCallback(() => {
    if (!availableRef.current) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.addEventListener("change", () => {
      // A picker can stay open while the page changes behind it.
      if (availableRef.current && input.files && input.files.length > 0)
        onUploadFiles(collectPicked(Array.from(input.files)));
    });
    input.click();
  }, [onUploadFiles]);

  // Both pickers report paths: folder pickers include the chosen folder in webkitRelativePath.
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        if (availableRef.current)
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
