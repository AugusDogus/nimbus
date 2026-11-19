import { expect, test } from "bun:test";
import { PdfPages } from "./pdf-pages";

test("the pages endpoint sits beside each kind of preview URL", () => {
  expect(
    PdfPages.endpoint("/api/files/download?path=a%20b%2Fc%26d.pdf&preview=1"),
  ).toBe("/api/files/pdf?path=a+b%2Fc%26d.pdf");
  expect(
    PdfPages.endpoint("/api/share/to%2Bken?path=in%2Fside.pdf&preview=1"),
  ).toBe("/api/share/to%2Bken/pdf?path=in%2Fside.pdf");
  // A link to a single file has an empty path.
  expect(PdfPages.endpoint("/api/share/token?path=&preview=1")).toBe(
    "/api/share/token/pdf?path=",
  );
  expect(PdfPages.endpoint("/api/share/token/thumbnail?path=a.pdf")).toBe(null);
  expect(PdfPages.endpoint("/api/files/download?preview=1")).toBe(null);
  expect(PdfPages.endpoint("https://example.com/a.pdf")).toBe(null);
});
