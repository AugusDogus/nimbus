/**
 * The WebDAV `If` request header (RFC 4918, section 10.4): lists of lock-token and ETag
 * conditions, optionally tagged with the resource they apply to. The header holds when any
 * list holds; a list holds when every condition in it holds.
 */
export type IfCondition = {
  negated: boolean;
  kind: "token" | "etag";
  value: string;
};
export type IfList = {
  /** Absolute URL or path from a tagged list; `null` applies the list to the request URL. */
  resource: string | null;
  conditions: IfCondition[];
};
export type IfHeader = IfList[];

export type IfParseError = { kind: "malformed"; message: string };

/** Parse an `If` header. A missing header is an empty list of lists, which always holds. */
export function parseIfHeader(
  header: string | null,
): { ok: true; value: IfHeader } | { ok: false; error: IfParseError } {
  const lists: IfList[] = [];
  if (!header) return { ok: true, value: lists };
  let index = 0;
  let resource: string | null = null;
  const malformed = (message: string) => ({
    ok: false as const,
    error: {
      kind: "malformed" as const,
      message: `Invalid If header: ${message}`,
    },
  });
  const skipSpace = () => {
    while (index < header.length && /\s/.test(header.charAt(index))) index++;
  };
  const readUntil = (close: string) => {
    const end = header.indexOf(close, index);
    if (end < 0) return null;
    const value = header.slice(index, end);
    index = end + 1;
    return value;
  };
  skipSpace();
  const tagged = header.charAt(index) === "<";
  while (index < header.length) {
    skipSpace();
    if (index >= header.length) break;
    if (header.charAt(index) === "<") {
      if (!tagged) return malformed("a resource tag follows an untagged list.");
      index++;
      resource = readUntil(">");
      if (resource === null) return malformed("a resource tag is not closed.");
      skipSpace();
    }
    if (header.charAt(index) !== "(")
      return malformed(`expected "(" at position ${index}.`);
    if (tagged && resource === null)
      return malformed("a tagged header starts with an untagged list.");
    index++;
    const conditions: IfCondition[] = [];
    for (;;) {
      skipSpace();
      const next = header.charAt(index);
      if (next === ")") {
        index++;
        break;
      }
      let negated = false;
      if (header.slice(index, index + 3).toLowerCase() === "not") {
        negated = true;
        index += 3;
        skipSpace();
      }
      const open = header.charAt(index);
      if (open !== "<" && open !== "[")
        return malformed(`expected a lock token or ETag at position ${index}.`);
      index++;
      const value = readUntil(open === "<" ? ">" : "]");
      if (value === null) return malformed("a condition is not closed.");
      conditions.push({
        negated,
        kind: open === "<" ? "token" : "etag",
        value,
      });
    }
    if (!conditions.length) return malformed("a list has no conditions.");
    lists.push({ resource: tagged ? resource : null, conditions });
  }
  return { ok: true, value: lists };
}

/** Lock tokens the client submitted. A negated token never authorizes a write. */
export function submittedLockTokens(lists: IfHeader): string[] {
  return lists.flatMap((list) =>
    list.conditions
      .filter((condition) => condition.kind === "token" && !condition.negated)
      .map((condition) => condition.value),
  );
}

/** State of one resource needed to evaluate conditions against it. */
export type IfResourceState = {
  /** Current entity tag including quotes, or null when the resource does not exist. */
  etag: string | null;
  /** Tokens of locks whose scope covers the resource. */
  lockTokens: readonly string[];
};

/** Whether the header holds. `resolve` maps a list's resource (null for the request URL) to its state. */
export async function evaluateIfHeader(
  lists: IfHeader,
  resolve: (resource: string | null) => Promise<IfResourceState | null>,
): Promise<boolean> {
  if (!lists.length) return true;
  for (const list of lists) {
    const state = await resolve(list.resource);
    const holds = list.conditions.every((condition) => {
      const matches =
        state !== null &&
        (condition.kind === "token"
          ? state.lockTokens.includes(condition.value)
          : state.etag === condition.value);
      return condition.negated ? !matches : matches;
    });
    if (holds) return true;
  }
  return false;
}
