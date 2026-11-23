import { Link } from "@/components/link";
import { Button } from "@/components/ui/button";
import { DriveRoot } from "@nimbus/api/drive-root";

export function FolderError({ reset }: { reset: () => void }) {
  return (
    <div className="space-y-4 rounded-lg border p-8">
      <h1 className="text-balance text-xl font-semibold">
        Could not open this folder
      </h1>
      <p className="text-pretty text-sm text-muted-foreground">
        The folder may have moved, your access may have changed, or the server
        may be unavailable. Your files have not been changed.
      </p>
      <div className="flex gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button variant="tertiary" render={<Link to="/" />}>
          Open {DriveRoot.label}
        </Button>
      </div>
    </div>
  );
}
