/**
 * Namespace-aware XML for WebDAV request and response bodies, built on Bun's native parser.
 * Bun keeps prefixes but does not resolve them, and it expands internal DTD entities, so
 * this adapter rejects DOCTYPE declarations and resolves every name to its namespace URI.
 */
import { z } from "zod";

export const DAV = "DAV:";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const maxDepth = 64;
/** Request bodies are small property and lock documents. */
export const maxXmlBytes = 1024 * 1024;

export type XmlName = { namespace: string; local: string };
export type XmlAttribute = XmlName & { value: string };
export type XmlElement = XmlName & {
  attributes: XmlAttribute[];
  children: XmlNode[];
  /** The xml:lang in scope, which a stored dead property must keep (RFC 4918, section 4.3). */
  lang: string | null;
};
export type XmlNode = XmlElement | string;
export type XmlError = { kind: "invalid-xml"; message: string };

type RawElement = {
  name: string;
  attributes: Record<string, string>;
  children: (RawElement | string)[];
};
const rawElement: z.ZodType<RawElement> = z.lazy(() =>
  z.object({
    name: z.string(),
    attributes: z.record(z.string(), z.string()),
    children: z.array(z.union([z.string(), rawElement])),
  }),
);

const ncName = /^[\p{L}_][\p{L}\p{N}_.\-·̀-ͯ‿-⁀]*$/u;

function split(qualified: string) {
  const colon = qualified.indexOf(":");
  return colon < 0
    ? { prefix: null, local: qualified }
    : { prefix: qualified.slice(0, colon), local: qualified.slice(colon + 1) };
}

function invalid(message: string): { ok: false; error: XmlError } {
  return {
    ok: false,
    error: {
      kind: "invalid-xml",
      message: `The XML request body is invalid: ${message}`,
    },
  };
}

class XmlResolveError extends Error {}

function resolve(
  raw: RawElement,
  scope: ReadonlyMap<string | null, string>,
  lang: string | null,
  depth: number,
): XmlElement {
  if (depth > maxDepth)
    throw new XmlResolveError(
      `elements are nested more than ${maxDepth} levels deep.`,
    );
  const bindings = new Map(scope);
  for (const [name, value] of Object.entries(raw.attributes)) {
    if (name === "xmlns") bindings.set(null, value);
    else if (name.startsWith("xmlns:")) {
      const prefix = name.slice(6);
      if (
        !ncName.test(prefix) ||
        prefix === "xmlns" ||
        (prefix === "xml") !== (value === XML_NAMESPACE) ||
        value === XMLNS_NAMESPACE ||
        !value
      )
        throw new XmlResolveError(
          `the namespace declaration ${name}="${value}" is not allowed.`,
        );
      bindings.set(prefix, value);
    }
  }
  const name = (qualified: string, isAttribute: boolean): XmlName => {
    const { prefix, local } = split(qualified);
    if (!ncName.test(local) || (prefix !== null && !ncName.test(prefix)))
      throw new XmlResolveError(`"${qualified}" is not a valid XML name.`);
    if (prefix === null)
      return {
        namespace: isAttribute ? "" : (bindings.get(null) ?? ""),
        local,
      };
    const namespace = bindings.get(prefix);
    if (namespace === undefined)
      throw new XmlResolveError(
        `the prefix "${prefix}" in "${qualified}" is not declared.`,
      );
    return { namespace, local };
  };
  const attributes: XmlAttribute[] = [];
  let elementLang = lang;
  for (const [qualified, value] of Object.entries(raw.attributes)) {
    if (qualified === "xmlns" || qualified.startsWith("xmlns:")) continue;
    const attribute = { ...name(qualified, true), value };
    if (
      attributes.some(
        (other) =>
          other.namespace === attribute.namespace &&
          other.local === attribute.local,
      )
    )
      throw new XmlResolveError(`the attribute "${qualified}" is repeated.`);
    if (attribute.namespace === XML_NAMESPACE && attribute.local === "lang")
      elementLang = value;
    attributes.push(attribute);
  }
  return {
    ...name(raw.name, false),
    attributes,
    lang: elementLang,
    children: raw.children.map((child) =>
      typeof child === "string"
        ? child
        : resolve(child, bindings, elementLang, depth + 1),
    ),
  };
}

/** Parse a request body. DOCTYPE declarations are refused, so entities never expand. */
export function parseXml(
  text: string,
): { ok: true; value: XmlElement } | { ok: false; error: XmlError } {
  if (/<!DOCTYPE/i.test(text))
    return invalid("document type declarations are not accepted.");
  let parsed: unknown;
  try {
    parsed = Bun.XML.parse(text, { compact: false });
  } catch (error) {
    return invalid(
      error instanceof Error ? error.message : "it could not be parsed.",
    );
  }
  const raw = rawElement.safeParse(parsed);
  if (!raw.success) return invalid("it has no single root element.");
  try {
    return {
      ok: true,
      value: resolve(raw.data, new Map([["xml", XML_NAMESPACE]]), null, 0),
    };
  } catch (error) {
    if (error instanceof XmlResolveError) return invalid(error.message);
    if (error instanceof RangeError)
      return invalid("elements are nested too deeply.");
    throw error;
  }
}

export const isElement = (node: XmlNode): node is XmlElement =>
  typeof node !== "string";
export const is = (element: XmlElement, namespace: string, local: string) =>
  element.namespace === namespace && element.local === local;
export const childElements = (element: XmlElement) =>
  element.children.filter(isElement);
export const child = (element: XmlElement, namespace: string, local: string) =>
  childElements(element).find((node) => is(node, namespace, local));
export const textOf = (element: XmlElement): string =>
  element.children
    .map((node) => (typeof node === "string" ? node : textOf(node)))
    .join("");

export const escapeXml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * Serialize an element so it is self-contained wherever it is embedded: every element
 * declares its default namespace and every namespaced attribute declares its prefix.
 * The xml:lang in scope is written on the root when it was inherited.
 */
export function serializeXml(
  element: XmlElement,
  parentNamespace: string | null = null,
  parentLang: string | null = null,
): string {
  const declarations: string[] = [];
  if (element.namespace !== parentNamespace)
    declarations.push(`xmlns="${escapeXml(element.namespace)}"`);
  const attributes = element.attributes.map((attribute, index) => {
    if (attribute.namespace === "")
      return `${attribute.local}="${escapeXml(attribute.value)}"`;
    if (attribute.namespace === XML_NAMESPACE)
      return `xml:${attribute.local}="${escapeXml(attribute.value)}"`;
    declarations.push(`xmlns:a${index}="${escapeXml(attribute.namespace)}"`);
    return `a${index}:${attribute.local}="${escapeXml(attribute.value)}"`;
  });
  const hasLang = element.attributes.some(
    (attribute) =>
      attribute.namespace === XML_NAMESPACE && attribute.local === "lang",
  );
  if (!hasLang && element.lang !== null && element.lang !== parentLang)
    attributes.push(`xml:lang="${escapeXml(element.lang)}"`);
  const open = [element.local, ...declarations, ...attributes].join(" ");
  const content = element.children
    .map((node) =>
      typeof node === "string"
        ? escapeXml(node)
        : serializeXml(node, element.namespace, element.lang),
    )
    .join("");
  return content ? `<${open}>${content}</${element.local}>` : `<${open}/>`;
}
