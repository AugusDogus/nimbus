/**
 * OAuth scopes an MCP client can hold. They narrow what a connection may do;
 * they never widen the account's own file permissions, which still apply.
 */
export type McpScope = "files:read" | "files:write" | "files:share";

const all: readonly McpScope[] = ["files:read", "files:write", "files:share"];

const isScope = (value: string): value is McpScope =>
  all.some((scope) => scope === value);

/** Space-separated scope string to known scopes (canonical order, deduplicated) and unknown tokens. */
const parse = (value: string) => {
  const tokens = value.split(" ").filter((token) => token.length > 0);
  return {
    scopes: all.filter((scope) => tokens.includes(scope)),
    unknown: tokens.filter((token) => !isScope(token)),
  };
};

const format = (scopes: readonly McpScope[]) =>
  all.filter((scope) => scopes.includes(scope)).join(" ");

const intersect = (a: readonly McpScope[], b: readonly McpScope[]) =>
  all.filter((scope) => a.includes(scope) && b.includes(scope));

const includesAll = (have: readonly McpScope[], need: readonly McpScope[]) =>
  need.every((scope) => have.includes(scope));

const descriptions: Record<McpScope, { title: string; detail: string }> = {
  "files:read": {
    title: "View your files",
    detail: "Browse, search, and read files and folders you can access, and see your trash and items shared with you.",
  },
  "files:write": {
    title: "Change your files",
    detail: "Create, edit, rename, and move files and folders, star items, and move items to trash or restore them.",
  },
  "files:share": {
    title: "Manage sharing",
    detail: "Create and revoke public links, and change who can access folders you administer.",
  },
};

export const McpScope = {
  read: "files:read",
  write: "files:write",
  share: "files:share",
  all,
  isScope,
  parse,
  format,
  intersect,
  includesAll,
  describe: (scope: McpScope) => descriptions[scope],
} as const;
