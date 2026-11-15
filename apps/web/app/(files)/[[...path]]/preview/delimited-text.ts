/** RFC 4180 records, read leniently: malformed quoting never throws. */
export function parseDelimited(
  text: string,
  delimiter: "," | "\t",
  maxRows: number,
) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (char === '"') quoted = false;
      else field += char;
      i++;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (rows.length >= maxRows)
        return { rows, truncated: i + 1 < text.length };
    } else field += char;
    i++;
  }
  if (field !== "" || row.length) endRow();
  return { rows, truncated: false };
}
