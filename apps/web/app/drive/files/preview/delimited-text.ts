/**
 * RFC 4180 records, read leniently: malformed quoting never throws. Each row keeps at most
 * `maxColumns` fields; `wide` reports that some row had more.
 */
export function parseDelimited(
  text: string,
  delimiter: "," | "\t",
  maxRows: number,
  maxColumns = Number.POSITIVE_INFINITY,
) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let wide = false;
  let i = 0;
  const endField = () => {
    if (row.length < maxColumns) row.push(field);
    else wide = true;
    field = "";
  };
  const endRow = () => {
    endField();
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
    else if (char === delimiter) endField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (rows.length >= maxRows)
        return { rows, truncated: i + 1 < text.length, wide };
    } else field += char;
    i++;
  }
  if (field !== "" || row.length) endRow();
  return { rows, truncated: false, wide };
}
