/** `name`, then `name (1)`, `name (2)`: the suffix sits before a file's extension. */
export function numberedName(name: string, index: number, isFile: boolean) {
  if (index === 0) return name;
  const dot = isFile ? name.lastIndexOf(".") : -1;
  return dot > 0
    ? `${name.slice(0, dot)} (${index})${name.slice(dot)}`
    : `${name} (${index})`;
}
