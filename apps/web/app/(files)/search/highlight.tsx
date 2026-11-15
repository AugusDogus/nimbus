/** `text` with the first case-insensitive occurrence of `query` marked. */
export function Highlighted({ text, query }: { text: string; query: string }) {
  const lower = text.toLocaleLowerCase();
  const needle = query.trim().toLocaleLowerCase();
  const start = needle ? lower.indexOf(needle) : -1;
  // Case mapping can change length (e.g. "İ"); then offsets would not line up.
  if (start < 0 || lower.length !== text.length) return text;
  const end = start + needle.length;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-xs bg-primary/20 text-inherit">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

/** "a/b/c.txt" → "a/b"; root items read as My Drive. */
export const parentLabel = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "My Drive" : path.slice(0, slash);
};
