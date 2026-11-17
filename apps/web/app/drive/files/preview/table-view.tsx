import { useMemo } from "react";
import { parseDelimited } from "./delimited-text";

const MAX_ROWS = 1000;
const MAX_COLUMNS = 100;
/** Rows shown shrink for wide tables, so one preview never renders more cells than this. */
const MAX_CELLS = 20_000;

export default function TableView({
  text,
  delimiter,
}: {
  text: string;
  delimiter: "," | "\t";
}) {
  const { rows, truncated, wide } = useMemo(
    () => parseDelimited(text, delimiter, MAX_ROWS + 1, MAX_COLUMNS),
    [text, delimiter],
  );
  const [header = [], ...body] = rows;
  const columns = rows.reduce((widest, row) => Math.max(widest, row.length), 1);
  const rowLimit = Math.min(MAX_ROWS, Math.floor(MAX_CELLS / columns));
  const shown = body.slice(0, rowLimit);
  const moreRows = truncated || body.length > rowLimit;
  return (
    <div>
      <table className="w-max min-w-full border-collapse text-left text-sm">
        <thead className="sticky top-0 bg-muted">
          <tr>
            {header.map((cell, index) => (
              <th
                key={index}
                scope="col"
                className="whitespace-pre border-b px-3 py-2 font-medium"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {shown.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-border/60">
              {row.map((cell, index) => (
                <td key={index} className="whitespace-pre px-3 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(moreRows || wide) && (
        <p className="p-3 text-xs text-muted-foreground">
          Showing the first{" "}
          {[
            moreRows && `${rowLimit.toLocaleString()} rows`,
            wide && `${MAX_COLUMNS.toLocaleString()} columns`,
          ]
            .filter(Boolean)
            .join(" and ")}
          . Use Show source or download the file to see the rest.
        </p>
      )}
    </div>
  );
}
