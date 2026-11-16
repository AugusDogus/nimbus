import { Link } from "@/components/link";
import { Button } from "@/components/ui/button";

export function FolderNotFound() {
  return (
    <div className="space-y-4 rounded-lg border p-8">
      <h1 className="text-balance text-xl font-semibold">Folder not found</h1>
      <p className="text-pretty text-sm text-muted-foreground">
        This folder may have moved or been deleted. Open your drive to find it
        again.
      </p>
      <Button nativeButton={false} render={<Link to="/" />}>
        Open My Drive
      </Button>
    </div>
  );
}
