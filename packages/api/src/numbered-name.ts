/** The longest name, in UTF-8 bytes, that Linux filesystems accept for one file or folder. */
export const NAME_BYTES = 255;

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** `text` cut to at most `limit` UTF-8 bytes, whole characters only. */
function fitBytes(text: string, limit: number) {
  if (bytes(text) <= limit) return text;
  let kept = "";
  let used = 0;
  for (const character of text) {
    const size = bytes(character);
    if (used + size > limit) break;
    kept += character;
    used += size;
  }
  return kept;
}

/**
 * `name`, then `name (1)`, `name (2)`: the suffix sits before a file's extension. A numbered
 * name that would pass the 255-byte limit is shortened before the suffix, keeping the
 * extension, so it can always be created. An extension too long to keep with any of the name
 * is shortened as part of the name instead.
 */
export function numberedName(name: string, index: number, isFile: boolean) {
  if (index === 0) return name;
  const suffix = ` (${index})`;
  const dot = isFile ? name.lastIndexOf(".") : -1;
  const [stem, extension] =
    dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const room = NAME_BYTES - bytes(suffix) - bytes(extension);
  if (room >= 1) return `${fitBytes(stem, room)}${suffix}${extension}`;
  return `${fitBytes(name, NAME_BYTES - bytes(suffix))}${suffix}`;
}
