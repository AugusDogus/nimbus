import { Link } from "@/components/link";
import { Button, buttonVariants } from "@/components/ui/button";

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
        <Link to="/" className={buttonVariants({ variant: "outline" })}>
          Open My Drive
        </Link>
      </div>
    </div>
  );
}
