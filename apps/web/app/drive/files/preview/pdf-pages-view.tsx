import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PdfPages } from "@/lib/pdf-pages";

/**
 * A PDF as images of its pages, rendered by the server, for browsers that cannot show a PDF in
 * a frame. Pages load as they scroll near, at the width the screen needs, so a long document
 * never holds more than the pages around the reader.
 */
export default function PdfPagesView({
  name,
  url,
}: {
  name: string;
  /** The PDF's inline preview URL, beside which its pages are served. */
  url: string;
}) {
  const pagesUrl = PdfPages.endpoint(url);
  if (pagesUrl === null)
    return (
      <p role="alert" className="text-pretty text-sm text-muted-foreground">
        This PDF could not be shown here. Open it in a new tab or download it.
      </p>
    );
  return <Pages name={name} pagesUrl={pagesUrl} />;
}

function Pages({ name, pagesUrl }: { name: string; pagesUrl: string }) {
  const pages = useQuery({
    queryKey: ["pdf-pages", pagesUrl],
    queryFn: ({ signal }) => PdfPages.load(pagesUrl, signal),
    // A public link counts the first view; another try after a refusal would only fail again.
    retry: false,
    // The pages stay as loaded while open; the file's version is in each page's address.
    staleTime: Infinity,
    gcTime: 0,
  });
  if (pages.isPending)
    return (
      <Skeleton aria-label="Loading preview" className="h-[65dvh] w-full" />
    );
  if (pages.isError)
    return (
      <p role="alert" className="text-pretty text-sm text-muted-foreground">
        {pages.error.message}
      </p>
    );
  const { count, sizes } = pages.data;
  return (
    <div className="space-y-2">
      <div
        role="region"
        aria-label={`Pages of ${name}`}
        className="h-[65dvh] w-full overflow-auto overscroll-contain rounded-md border bg-muted"
        data-preview-scroll
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3 p-3">
          {sizes.map((size, index) => (
            <PageImage
              key={index}
              number={index + 1}
              count={count}
              width={size.width}
              height={size.height}
              src={(width) =>
                PdfPages.pageUrl(pagesUrl, pages.data, index + 1, width)
              }
            />
          ))}
        </div>
      </div>
      {count > sizes.length && (
        <p className="text-pretty text-xs text-muted-foreground">
          Showing the first {sizes.length.toLocaleString()} of{" "}
          {count.toLocaleString()} pages. Open the PDF to see the rest.
        </p>
      )}
    </div>
  );
}

function PageImage({
  number,
  count,
  width,
  height,
  src,
}: {
  number: number;
  count: number;
  width: number;
  height: number;
  src: (width: number) => string;
}) {
  const [failed, setFailed] = useState(false);
  const label = `Page ${number} of ${count}`;
  // The page's own proportions hold its place before it loads or when it fails.
  if (failed)
    return (
      <div
        style={{ aspectRatio: `${width} / ${height}` }}
        className="flex items-center justify-center rounded-sm bg-background p-4 text-center text-sm text-muted-foreground"
      >
        {label} could not be shown. Open the PDF to see it.
      </div>
    );
  return (
    <img
      src={src(960)}
      srcSet={PdfPages.widths.map((w) => `${src(w)} ${w}w`).join(", ")}
      // `auto` picks the laid-out width where supported; the rest is the widest the column gets.
      sizes="auto, (min-width: 48rem) 48rem, 100vw"
      width={Math.round(width)}
      height={Math.round(height)}
      alt={label}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      // A blank sheet while the page loads, in either theme. Inline, because a new utility
      // class would land in the stylesheet every page loads at startup.
      style={{ backgroundColor: "#fff" }}
      className="h-auto w-full rounded-sm shadow-sm"
    />
  );
}
