/**
 * WebDAV properties: the live properties Nimbus computes from the filesystem, the dead
 * properties clients store, and the PROPFIND and PROPPATCH request formats (RFC 4918,
 * sections 9.1, 9.2 and 15; RFC 4331 for quota).
 */
import { lstat } from "node:fs/promises";
import type { DavProperty, DavPropertyName } from "@nimbus/api/drive-store";
import type { FileEntry } from "@nimbus/api/file-browser";
import type { FileLock } from "@nimbus/api/file-mutations";
import type { FilesystemCapacity } from "@nimbus/api/filesystem-capacity";
import { safePath } from "@nimbus/api/file-operations";
import {
  DAV,
  childElements,
  escapeXml,
  is,
  serializeXml,
  textOf,
  type XmlElement,
  type XmlName,
} from "./webdav-xml";

export const davHref = (path: string, type: FileEntry["type"]) =>
  `/dav/${path.split("/").map(encodeURIComponent).join("/")}${type === "dir" && path ? "/" : ""}`;

export const entityTag = (entry: Pick<FileEntry, "mtime" | "size">) =>
  `"${entry.mtime}-${entry.size}"`;

/** Live properties returned for allprop, in response order. */
const allpropNames = [
  "displayname",
  "resourcetype",
  "getcontentlength",
  "getcontenttype",
  "getlastmodified",
  "creationdate",
  "getetag",
  "supportedlock",
  "lockdiscovery",
] as const;
/** RFC 4331 quota properties are returned only when requested by name. */
const quotaNames = ["quota-available-bytes", "quota-used-bytes"] as const;
type LiveName = (typeof allpropNames)[number] | (typeof quotaNames)[number];
const liveNames: ReadonlySet<string> = new Set([...allpropNames, ...quotaNames]);
const isLive = (name: XmlName): name is XmlName & { local: LiveName } =>
  name.namespace === DAV && liveNames.has(name.local);

const statusText: Record<number, string> = {
  200: "OK",
  403: "Forbidden",
  404: "Not Found",
  424: "Failed Dependency",
  507: "Insufficient Storage",
};

/** An empty property element named `name`, self-contained in any namespace. */
const emptyElement = (name: XmlName) =>
  name.namespace === DAV
    ? `<d:${name.local}/>`
    : `<${name.local} xmlns="${escapeXml(name.namespace)}"/>`;

/** Context shared by every resource in one PROPFIND response. */
export type PropfindContext = {
  locks: (path: string) => FileLock[];
  capacity: () => Promise<FilesystemCapacity | null>;
};

function activeLock(lock: FileLock, rootType: FileEntry["type"]) {
  const remaining = Math.max(0, Math.ceil((lock.expiresAt - Date.now()) / 1000));
  return `<d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:${lock.scope}/></d:lockscope><d:depth>${lock.depth}</d:depth>${lock.owner ? `<d:owner>${lock.owner}</d:owner>` : ""}<d:timeout>Second-${remaining}</d:timeout><d:locktoken><d:href>${escapeXml(lock.token)}</d:href></d:locktoken><d:lockroot><d:href>${escapeXml(davHref(lock.path, rootType))}</d:href></d:lockroot></d:activelock>`;
}

/** Locks covering a resource. Only a collection's lock can cover a resource it does not root. */
export const lockDiscovery = (
  locks: readonly FileLock[],
  resource: Pick<FileEntry, "path" | "type">,
) =>
  `<d:lockdiscovery>${locks.map((lock) => activeLock(lock, lock.path === resource.path ? resource.type : "dir")).join("")}</d:lockdiscovery>`;

/** Inner XML of a live property, or null when it is not defined for the resource. */
async function liveValue(
  entry: FileEntry,
  name: LiveName,
  context: PropfindContext,
): Promise<string | null> {
  switch (name) {
    case "displayname":
      return escapeXml(entry.name);
    case "resourcetype":
      return entry.type === "dir" ? "<d:collection/>" : "";
    case "getcontentlength":
      return entry.type === "file" ? String(entry.size) : null;
    case "getcontenttype":
      return entry.type === "file"
        ? escapeXml(Bun.file(entry.name).type)
        : null;
    case "getlastmodified":
      return new Date(entry.mtime).toUTCString();
    case "creationdate": {
      // Some filesystems do not record birth time; report the modification time instead.
      const stats = await lstat((await safePath(entry.path)).absolute);
      return new Date(stats.birthtimeMs || stats.mtimeMs).toISOString();
    }
    case "getetag":
      return escapeXml(entityTag(entry));
    case "supportedlock":
      return "<d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry><d:lockentry><d:lockscope><d:shared/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry>";
    case "lockdiscovery":
      return lockDiscovery(context.locks(entry.path), entry).slice(
        "<d:lockdiscovery>".length,
        -"</d:lockdiscovery>".length,
      );
    case "quota-available-bytes": {
      const capacity = await context.capacity();
      return capacity ? String(capacity.availableBytes) : null;
    }
    case "quota-used-bytes": {
      // The drive shares its filesystem, so usage is reported for the filesystem as a whole.
      const capacity = await context.capacity();
      return capacity ? String(capacity.totalBytes - capacity.availableBytes) : null;
    }
  }
}

export type PropfindRequest =
  | { kind: "allprop"; include: XmlName[] }
  | { kind: "propname" }
  | { kind: "prop"; names: XmlName[] };

/** Interpret a PROPFIND body. An absent body means allprop. */
export function parsePropfind(
  body: XmlElement | null,
): { ok: true; value: PropfindRequest } | { ok: false; message: string } {
  if (!body) return { ok: true, value: { kind: "allprop", include: [] } };
  if (!is(body, DAV, "propfind"))
    return { ok: false, message: "A PROPFIND body must be a DAV:propfind element." };
  const children = childElements(body);
  const names = (element: XmlElement | undefined) =>
    element ? childElements(element).map(({ namespace, local }) => ({ namespace, local })) : [];
  if (children.some((element) => is(element, DAV, "propname")))
    return { ok: true, value: { kind: "propname" } };
  if (children.some((element) => is(element, DAV, "allprop")))
    return {
      ok: true,
      value: {
        kind: "allprop",
        include: names(children.find((element) => is(element, DAV, "include"))),
      },
    };
  const prop = children.find((element) => is(element, DAV, "prop"));
  if (!prop) return { ok: false, message: "A DAV:propfind body needs prop, allprop, or propname." };
  return { ok: true, value: { kind: "prop", names: names(prop) } };
}

const sameName = (a: XmlName, b: XmlName) =>
  a.namespace === b.namespace && a.local === b.local;

/** One DAV:response element for a resource. */
export async function propfindResponse(
  entry: FileEntry,
  request: PropfindRequest,
  dead: readonly DavProperty[],
  context: PropfindContext,
) {
  const byStatus = new Map<number, string[]>();
  const add = (status: number, xml: string) =>
    byStatus.set(status, [...(byStatus.get(status) ?? []), xml]);
  const live = async (local: LiveName) => {
    const value = await liveValue(entry, local, context);
    return value === null ? null : `<d:${local}>${value}</d:${local}>`;
  };
  const deadXml = (name: XmlName) =>
    dead.find((property) => sameName({ namespace: property.namespace, local: property.name }, name))?.xml;
  if (request.kind === "propname") {
    for (const local of allpropNames)
      if ((await liveValue(entry, local, context)) !== null) add(200, `<d:${local}/>`);
    for (const property of dead)
      add(200, emptyElement({ namespace: property.namespace, local: property.name }));
  } else {
    const requested: XmlName[] =
      request.kind === "prop"
        ? request.names
        : [
            ...allpropNames.map((local) => ({ namespace: DAV, local })),
            ...dead.map((property) => ({ namespace: property.namespace, local: property.name })),
            ...request.include,
          ];
    const seen: XmlName[] = [];
    for (const name of requested) {
      if (seen.some((other) => sameName(other, name))) continue;
      seen.push(name);
      const xml = isLive(name) ? await live(name.local) : deadXml(name);
      if (xml !== undefined && xml !== null) add(200, xml);
      // allprop omits live properties that do not apply, rather than reporting them missing.
      else if (request.kind === "prop" || !isLive(name)) add(404, emptyElement(name));
    }
  }
  const propstats = [...byStatus]
    .map(
      ([status, properties]) =>
        `<d:propstat><d:prop>${properties.join("")}</d:prop><d:status>HTTP/1.1 ${status} ${statusText[status] ?? ""}</d:status></d:propstat>`,
    )
    .join("");
  return `<d:response><d:href>${escapeXml(davHref(entry.path, entry.type))}</d:href>${propstats}</d:response>`;
}

export type PropertyUpdate =
  | { kind: "set"; name: XmlName; property: DavProperty; text: string }
  | { kind: "remove"; name: XmlName };

/** Interpret a PROPPATCH body as ordered set and remove instructions. */
export function parsePropertyUpdate(
  body: XmlElement | null,
): { ok: true; value: PropertyUpdate[] } | { ok: false; message: string } {
  if (!body || !is(body, DAV, "propertyupdate"))
    return { ok: false, message: "A PROPPATCH body must be a DAV:propertyupdate element." };
  const updates: PropertyUpdate[] = [];
  for (const instruction of childElements(body)) {
    const kind = is(instruction, DAV, "set") ? "set" : is(instruction, DAV, "remove") ? "remove" : null;
    if (!kind) continue;
    for (const prop of childElements(instruction).filter((element) => is(element, DAV, "prop")))
      for (const element of childElements(prop)) {
        const name = { namespace: element.namespace, local: element.local };
        updates.push(
          kind === "set"
            ? { kind, name, text: textOf(element), property: { namespace: name.namespace, name: name.local, xml: serializeXml(element) } }
            : { kind, name },
        );
      }
  }
  if (!updates.length) return { ok: false, message: "The DAV:propertyupdate body names no properties." };
  return { ok: true, value: updates };
}

/** Largest stored value of a single dead property. */
const maxPropertyBytes = 64 * 1024;

export type PropertyPlan =
  | { kind: "apply"; set: DavProperty[]; remove: DavPropertyName[]; names: XmlName[] }
  | { kind: "reject"; statuses: { name: XmlName; status: number }[] };

/**
 * Decide a PROPPATCH atomically: live properties are protected, and when any instruction
 * fails every other one fails with 424 (RFC 4918, section 9.2).
 */
export function planPropertyUpdate(updates: readonly PropertyUpdate[]): PropertyPlan {
  const failures = updates.map((update) =>
    isLive(update.name)
      ? 403
      : update.kind === "set" && Buffer.byteLength(update.property.xml) > maxPropertyBytes
        ? 507
        : null,
  );
  const names: XmlName[] = [];
  for (const update of updates)
    if (!names.some((name) => sameName(name, update.name))) names.push(update.name);
  if (failures.some((status) => status !== null))
    return {
      kind: "reject",
      statuses: names.map((name) => ({
        name,
        status:
          failures.find((status, index) => status !== null && sameName(updates[index]?.name ?? name, name)) ?? 424,
      })),
    };
  // Instructions apply in document order, so the last one for each name wins.
  const final = new Map<string, PropertyUpdate>();
  for (const update of updates) final.set(`${update.name.namespace}\n${update.name.local}`, update);
  const set: DavProperty[] = [];
  const remove: DavPropertyName[] = [];
  for (const update of final.values())
    if (update.kind === "set") set.push(update.property);
    else remove.push({ namespace: update.name.namespace, name: update.name.local });
  return { kind: "apply", set, remove, names };
}

export function proppatchResponse(path: string, type: FileEntry["type"], statuses: readonly { name: XmlName; status: number }[]) {
  const byStatus = new Map<number, string[]>();
  for (const { name, status } of statuses)
    byStatus.set(status, [...(byStatus.get(status) ?? []), emptyElement(name)]);
  const propstats = [...byStatus]
    .map(
      ([status, properties]) =>
        `<d:propstat><d:prop>${properties.join("")}</d:prop><d:status>HTTP/1.1 ${status} ${statusText[status] ?? ""}</d:status>${status === 403 ? "<d:error><d:cannot-modify-protected-property/></d:error>" : ""}</d:propstat>`,
    )
    .join("");
  return `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${escapeXml(davHref(path, type))}</d:href>${propstats}</d:response></d:multistatus>`;
}
