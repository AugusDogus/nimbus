import { expect, test } from "bun:test";
import {
  childElements,
  parseXml,
  serializeXml,
  textOf,
  type XmlElement,
} from "./webdav-xml";

const parse = (text: string): XmlElement => {
  const result = parseXml(text);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

test("resolves default namespaces, unusual prefixes, rebinding, and undeclared defaults", () => {
  const root = parse(
    `<propfind xmlns="DAV:"><prop><getetag/><q:x xmlns:q="urn:a"/><y xmlns=""/><D:z xmlns:D="urn:rebound"/></prop></propfind>`,
  );
  expect([root.namespace, root.local]).toEqual(["DAV:", "propfind"]);
  const [prop] = childElements(root);
  if (!prop) throw new Error("Expected prop");
  expect(
    childElements(prop).map(({ namespace, local }) => [namespace, local]),
  ).toEqual([
    ["DAV:", "getetag"],
    ["urn:a", "x"],
    ["", "y"],
    ["urn:rebound", "z"],
  ]);
});

test("refuses entity declarations, undeclared prefixes, duplicate expanded attributes, and deep nesting", () => {
  const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><a>&lol2;</a>`;
  for (const text of [
    laughs,
    "<a:b/>",
    `<a xmlns:p="urn:x" xmlns:q="urn:x" p:k="1" q:k="2"/>`,
    "<a>".repeat(100) + "</a>".repeat(100),
    "<a><b></a>",
    `<a xmlns:p=""/>`,
  ])
    expect(parseXml(text).ok).toBe(false);
});

test("keeps mixed content, CDATA, and the inherited xml:lang when serializing a property", () => {
  const root = parse(
    `<D:prop xmlns:D="DAV:" xml:lang="fr"><x xmlns="http://ex/">a <b>bold</b> &amp; <![CDATA[<raw>]]></x></D:prop>`,
  );
  const [property] = childElements(root);
  if (!property) throw new Error("Expected property");
  expect(textOf(property)).toBe("a bold & <raw>");
  const serialized = serializeXml(property);
  expect(serialized).toBe(
    `<x xmlns="http://ex/" xml:lang="fr">a <b>bold</b> &amp; &lt;raw&gt;</x>`,
  );
  expect(serializeXml(parse(serialized))).toBe(serialized);
});
