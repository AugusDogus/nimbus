import { Search } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { lazyComponent } from "@/components/lazy-component";
import { Input } from "@/components/ui/input";
import { CodeLoad } from "@/lib/code-load";
import { SearchField } from "./search-field";

// The header ships a plain search form. Suggestions load on first focus and
// attach to this same input, so nothing remounts and focus is never lost.
const Suggestions = lazyComponent(() => import("./search-suggestions"));

/**
 * The header's search field. In a split view, and on results searched from one, the split stays:
 * results carry it, and a folder opened from them or from the suggestions opens in the active
 * pane (see `SplitAddress`).
 */
export function SearchBox() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const listbox = useId();
  const [focused, setFocused] = useState(false);
  return (
    <form
      role="search"
      className={SearchField.form}
      onSubmit={(event) => {
        // Forms inside a preview dialog portal bubble here through React.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        const query = new FormData(event.currentTarget).get("q");
        if (typeof query !== "string" || !query.trim()) return;
        const q = query.trim();
        // Only an address with a right-hand folder can hold a split view to carry.
        if (!new URLSearchParams(location.search).has("right"))
          void navigate({ to: "/search", search: { q } });
        else
          void CodeLoad.load(() => import("../files/split/split-address")).then(
            ({ SplitAddress }) => {
              const split = SplitAddress.here();
              void navigate({
                to: "/search",
                search: { q, ...(split && SplitAddress.carry(split)) },
              });
            },
            (error: unknown) => CodeLoad.failed(error),
          );
      }}
    >
      <Search className={SearchField.icon} />
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
        placeholder={SearchField.placeholder}
        data-shape="search"
        onFocus={() => setFocused(true)}
        className={SearchField.input}
      />
      {focused && (
        <Suggestions
          id={listbox}
          input={input}
          navigate={(href) => void navigate({ href })}
        />
      )}
    </form>
  );
}
