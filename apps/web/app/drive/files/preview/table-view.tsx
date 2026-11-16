import { useMemo } from "react";
import { parseDelimited } from "./delimited-text";

const MAX_ROWS = 1000;

export default function TableView({
  text,
  delimiter,
}: {
  text: string;
  delimiter: "," | "\t";
}) {
  const { rows, truncated } = useMemo(
    () => parseDelimited(text, delimiter, MAX_ROWS + 1),
    [text, delimiter],
  );
  const [header = [], ...body] = rows;
  const shown = body.slice(0, MAX_ROWS);
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
      {(truncated || body.length > MAX_ROWS) && (
        <p className="p-3 text-xs text-muted-foreground">
          Showing the first {MAX_ROWS.toLocaleString()} rows. Use Show source or
          download the file to see the rest.
        </p>
      )}
    </div>
  );
}
