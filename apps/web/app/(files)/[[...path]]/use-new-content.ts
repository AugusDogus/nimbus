import { useCallback, useRef, useState } from "react";

type UseNewContentOptions = {
  onCreateFolder: (name: string) => Promise<void>;
  onUploadFiles: (files: FileList) => void;
};

export type NewContentState = ReturnType<typeof useNewContent>;

export function useNewContent({ onCreateFolder, onUploadFiles }: UseNewContentOptions) {
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [creating, setCreating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openFolderDialog = useCallback(() => {
    setFolderName("");
    setFolderDialogOpen(true);
  }, []);

  const handleCreateFolder = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!folderName.trim()) return;
      setCreating(true);
      try {
        await onCreateFolder(folderName.trim());
        setFolderDialogOpen(false);
        setFolderName("");
      } catch {
        // error toast from hook
      } finally {
        setCreating(false);
      }
    },
    [folderName, onCreateFolder],
  );

  const triggerFileInput = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        onUploadFiles(e.target.files);
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
    fileInputRef,
    openFolderDialog,
    handleCreateFolder,
    triggerFileInput,
    handleFileChange,
  };
}
