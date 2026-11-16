import { expect, test } from "bun:test";
import {
  evaluateIfHeader,
  parseIfHeader,
  submittedLockTokens,
  type IfHeader,
  type IfResourceState,
} from "./webdav-if";

const token = "opaquelocktoken:4f8b2a64-6e0b-4c9b-8d0a-2a3e5f0c1d22";
const parse = (header: string): IfHeader => {
  const result = parseIfHeader(header);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const locked: IfResourceState = { etag: '"v1"', lockTokens: [token] };
const holds = (header: string, state: IfResourceState | null = locked) =>
  evaluateIfHeader(parse(header), async () => state);

test("parses untagged and tagged lists with negation and ETags", () => {
  expect(parse(`(<${token}> ["v1"]) (Not <DAV:no-lock>)`)).toEqual([
    {
      resource: null,
      conditions: [
        { negated: false, kind: "token", value: token },
        { negated: false, kind: "etag", value: '"v1"' },
      ],
    },
    {
      resource: null,
      conditions: [{ negated: true, kind: "token", value: "DAV:no-lock" }],
    },
  ]);
  expect(
    parse(`<http://host/dav/a%20b> (<${token}>) </dav/c> (["x"])`).map(
      (list) => list.resource,
    ),
  ).toEqual(["http://host/dav/a%20b", "/dav/c"]);
});

test("rejects malformed headers", () => {
  for (const header of [
    "<",
    "(",
    "()",
    "(<a>",
    "x",
    "(<a>) <b> (<c>)",
    "(<a> foo)",
  ])
    expect(parseIfHeader(header).ok).toBe(false);
});

test("collects only positive lock tokens", () => {
  expect(submittedLockTokens(parse(`(Not <${token}>) (<other>)`))).toEqual([
    "other",
  ]);
});

test("evaluates lists as a disjunction of conjunctions", async () => {
  expect(await holds(`(<${token}>)`)).toBe(true);
  expect(await holds(`(<${token}> ["v1"])`)).toBe(true);
  expect(await holds(`(<${token}> ["stale"])`)).toBe(false);
  expect(await holds(`(<${token}> ["stale"]) (Not <DAV:no-lock> ["v1"])`)).toBe(
    true,
  );
  expect(
    await holds(`(<${token}> ["stale"]) (Not <DAV:no-lock> ["stale"])`),
  ).toBe(false);
  expect(await holds("(<opaquelocktoken:corrupt>)")).toBe(false);
  expect(await holds(`(Not <${token}>)`, null)).toBe(true);
  expect(await evaluateIfHeader([], async () => null)).toBe(true);
});
