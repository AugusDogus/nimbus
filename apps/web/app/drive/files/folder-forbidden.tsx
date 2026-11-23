import { Link } from "@/components/link";
import { Button } from "@/components/ui/button";
import { NavPlace } from "./nav-place";

/** A folder the account may not open. Says nothing about whether it exists. */
export function FolderForbidden() {
  return (
    <div className="space-y-4 rounded-lg border p-8">
      <h1 className="text-balance text-xl font-semibold">
        You do not have access to this folder
      </h1>
      <p className="text-pretty text-sm text-muted-foreground">
        Ask a server administrator, or the person who shared it with you, for
        access. Folders shared with you are listed in {NavPlace.labels.shared}.
      </p>
      <Button render={<Link to="/shared" />}>
        Open {NavPlace.labels.shared}
      </Button>
    </div>
  );
}
