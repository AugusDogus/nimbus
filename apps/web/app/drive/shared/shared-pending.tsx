/**
 * What the Public links and File requests tabs show before their lists load: their intros and a
 * loading line. The tabs and the server's placeholder for them draw the same.
 */
export function PublicLinksIntro() {
  return (
    <p className="text-pretty text-sm text-muted-foreground">
      Manage public links you created. Use an item’s Share action to create a
      new link.
    </p>
  );
}

export function PublicLinksLoading() {
  return <p>Loading links…</p>;
}

export function PublicLinksPending() {
  return (
    <div className="space-y-6">
      <PublicLinksIntro />
      <PublicLinksLoading />
    </div>
  );
}

export function FileRequestsIntro() {
  return (
    <p className="text-pretty text-sm text-muted-foreground">
      Upload links let people without an account add files to a folder. Use a
      folder’s Share action to create one.
    </p>
  );
}

export function FileRequestsLoading() {
  return <p>Loading upload links…</p>;
}

export function FileRequestsPending() {
  return (
    <div className="space-y-6">
      <FileRequestsIntro />
      <FileRequestsLoading />
    </div>
  );
}
