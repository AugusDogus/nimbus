"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { lazy, Suspense, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

// The header ships a plain search form. Suggestions load on first focus and
// attach to this same input, so nothing remounts and focus is never lost.
const Suggestions = lazy(() => import("./search-suggestions"));

export function SearchBox() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const listbox = useId();
  const [focused, setFocused] = useState(false);
  return (
    <form
      role="search"
      className="relative min-w-0 max-w-lg flex-1"
      onSubmit={(event) => {
        // Forms inside a preview dialog portal bubble here through React.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        const query = new FormData(event.currentTarget).get("q");
        if (typeof query === "string" && query.trim())
          router.push(`/search?q=${encodeURIComponent(query.trim())}`);
      }}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={input}
        type="search"
        name="q"
        role="combobox"
        aria-label="Search files"
        aria-autocomplete="list"
        aria-controls={listbox}
        // Constant here; the suggestions update it on the element itself.
        aria-expanded="false"
        autoComplete="off"
        placeholder="Search files"
        onFocus={() => setFocused(true)}
        className="h-9 rounded-lg border-transparent bg-muted/70 pl-10 shadow-none focus-visible:border-ring md:h-10 dark:bg-sidebar/70"
      />
      {focused && (
        <Suspense fallback={null}>
          {/* The router comes from here: importing next/navigation in the
              lazy chunk makes the bundler re-split the shared root chunks. */}
          <Suggestions id={listbox} input={input} navigate={router.push} />
        </Suspense>
      )}
    </form>
  );
}
