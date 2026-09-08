"use client";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useUploads } from "./upload-provider";

export function UploadProgress() {
  const upload = useUploads();
  if (!upload.isUploading) return null;
  return (
    <div role="status" className="space-y-2 border-b px-4 py-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="truncate">
          Uploading {upload.fileName} · {upload.progress}% · {upload.remaining}{" "}
          remaining
        </span>
        <Button size="sm" variant="outline" onClick={upload.cancelUpload}>
          Cancel upload
        </Button>
      </div>
      <Progress aria-label="Upload progress" value={upload.progress} />
    </div>
  );
}
