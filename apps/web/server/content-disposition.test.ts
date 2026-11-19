import { expect, test } from "bun:test";
import { ContentDisposition } from "./content-disposition";

test("keeps a plain name as is in both parameters", () => {
  expect(
    ContentDisposition.header("attachment", "Trip-Checklist-Thu-Nov-19.pdf"),
  ).toBe(
    `attachment; filename="Trip-Checklist-Thu-Nov-19.pdf"; filename*=UTF-8''Trip-Checklist-Thu-Nov-19.pdf`,
  );
});

test("encodes everything outside RFC 8187 attr-char, and spells the fallback in ASCII", () => {
  expect(ContentDisposition.header("inline", `a'b(c)*d!~"\\%;,.pdf`)).toBe(
    `inline; filename="a'b(c)*d!~___;,.pdf"; filename*=UTF-8''a%27b%28c%29%2Ad!~%22%5C%25%3B%2C.pdf`,
  );
  expect(ContentDisposition.header("attachment", "日本語.pdf")).toBe(
    `attachment; filename="___.pdf"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf`,
  );
});

test("never lets a name break out of the header", () => {
  const header = ContentDisposition.header(
    "attachment",
    "a\r\nSet-Cookie: x=1\u0000\u007f\u2028.pdf",
  );
  expect(header).not.toMatch(/[\u0000-\u001f\u007f-\uffff]/);
  expect(header).toBe(
    `attachment; filename="a__Set-Cookie: x=1___.pdf"; filename*=UTF-8''a%0D%0ASet-Cookie%3A%20x%3D1%00%7F%E2%80%A8.pdf`,
  );
  // A lone surrogate cannot be encoded as UTF-8; it is replaced rather than thrown on.
  expect(ContentDisposition.header("attachment", "a\ud800.pdf")).toBe(
    `attachment; filename="a_.pdf"; filename*=UTF-8''a%EF%BF%BD.pdf`,
  );
  // Headers accept it whole.
  expect(() =>
    new Headers({ "Content-Disposition": header }).get("content-disposition"),
  ).not.toThrow();
});

test("keeps very long names whole", () => {
  const name = `${"Ä".repeat(120)}.pdf`;
  const header = ContentDisposition.header("attachment", name);
  expect(header).toContain(`filename="${"A".repeat(120)}.pdf"`);
  expect(header).toContain(`filename*=UTF-8''${"%C3%84".repeat(120)}.pdf`);
});
