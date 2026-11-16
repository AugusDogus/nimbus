/** Shown for addresses that match no page, with the wording Next.js used. */
export function PageNotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center gap-5 p-6 text-center">
      <h1 className="border-r border-border pr-5 text-2xl font-medium">404</h1>
      <h2 className="text-sm">This page could not be found.</h2>
    </div>
  );
}
