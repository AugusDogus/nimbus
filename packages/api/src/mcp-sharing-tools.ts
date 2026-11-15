import { z } from "zod";
import { safePath } from "./file-operations";
import { McpScope } from "./mcp-scope";
import {
  additive,
  defineTool,
  destructive,
  idempotentChange,
  isoTime,
  pageInput,
  pageOutput,
  paginate,
  pathInput,
  permissionSchema,
  readOnly,
  toolFailure,
} from "./mcp-tool";

const linkOutput = z.object({
  id: z.string().describe("Pass to revoke_public_link"),
  path: z.string(),
  url: z.string().describe("Anyone with this URL can view and download the item"),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  passwordProtected: z.boolean(),
  downloadCount: z.number(),
});

type Link = {
  id: string;
  path: string;
  token: string;
  createdAt: number;
  expiresAt: number | null;
  passwordProtected: boolean;
  downloadCount: number;
};
const toLink = (origin: string, link: Link): z.input<typeof linkOutput> => ({
  id: link.id,
  path: link.path,
  url: `${origin}/s/${link.token}`,
  createdAt: isoTime(link.createdAt),
  expiresAt: link.expiresAt === null ? null : isoTime(link.expiresAt),
  passwordProtected: link.passwordProtected,
  downloadCount: link.downloadCount,
});

const listLinks = defineTool({
  name: "list_public_links",
  title: "List public links",
  description: "List the public links you created, newest first.",
  scope: McpScope.share,
  annotations: readOnly,
  input: z.object(pageInput(100, 500)),
  output: z.object({ links: z.array(linkOutput), ...pageOutput }),
  async run({ caller, context }, input) {
    const links = [...(await caller.shares.list())].sort((a, b) => b.createdAt - a.createdAt);
    const page = paginate(links, input);
    return { links: page.items.map((link) => toLink(context.origin, link)), nextCursor: page.nextCursor };
  },
});

const createLink = defineTool({
  name: "create_public_link",
  title: "Create public link",
  description:
    "Create a read-only public link to a file or folder you administer. Anyone with the URL can view and download it (a folder link includes everything inside) until it expires or is revoked. Confirm with the user before sharing content publicly.",
  scope: McpScope.share,
  annotations: additive,
  input: z.object({
    path: pathInput,
    expiresAt: z.iso.datetime({ offset: true }).optional().describe("ISO 8601 time when the link stops working. Omit for no expiry."),
    password: z.string().min(8).max(128).optional().describe("Optional password visitors must enter"),
  }),
  output: linkOutput,
  async run({ caller, context }, input) {
    const { token } = await caller.shares.create({
      path: input.path,
      expiresAt: input.expiresAt === undefined ? null : Date.parse(input.expiresAt),
      password: input.password,
    });
    const link = (await caller.shares.list()).find((entry) => entry.token === token);
    if (!link) throw toolFailure("NOT_FOUND", "The link was created but was removed before it could be returned, possibly by a concurrent move. List public links to check.");
    return toLink(context.origin, link);
  },
});

const revokeLink = defineTool({
  name: "revoke_public_link",
  title: "Revoke public link",
  description: "Permanently disable one of your public links. People who already downloaded the content keep their copies.",
  scope: McpScope.share,
  annotations: { ...destructive, idempotentHint: true },
  input: z.object({ linkId: z.string().uuid() }),
  output: z.object({ revoked: z.boolean() }),
  async run({ caller }, input) {
    if (!(await caller.shares.list()).some((link) => link.id === input.linkId))
      throw toolFailure("NOT_FOUND", "None of your public links has this id. Nothing was revoked. Use list_public_links to find it.");
    await caller.shares.revoke({ id: input.linkId });
    return { revoked: true };
  },
});

const grantOutput = z.object({
  grantId: z.string().describe("Pass to revoke_permission"),
  subject: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), name: z.string(), email: z.string() }),
    z.object({ type: z.literal("group"), name: z.string() }),
  ]),
  permission: permissionSchema,
});

const listPermissions = defineTool({
  name: "list_permissions",
  title: "List permissions",
  description:
    "List people and groups granted access directly on a file or folder you administer. Access inherited from parent folders is not listed; check those folders too.",
  scope: McpScope.share,
  annotations: readOnly,
  input: z.object({ path: pathInput }),
  output: z.object({ path: z.string(), grants: z.array(grantOutput) }),
  async run({ caller }, input) {
    const target = await safePath(input.path);
    const grants = await caller.access.permissions({ path: target.relative });
    const [people, groups] = await Promise.all([caller.access.people(), caller.access.groups()]);
    return {
      path: target.relative,
      grants: grants.map((grant) => {
        if (grant.subject.type === "user") {
          const id = grant.subject.id;
          const person = people.find((entry) => entry.id === id);
          return {
            grantId: grant.id,
            subject: { type: "user" as const, name: person?.name ?? "Disabled account", email: person?.email ?? "" },
            permission: grant.permission,
          };
        }
        const id = grant.subject.id;
        return {
          grantId: grant.id,
          subject: { type: "group" as const, name: groups.find((group) => group.id === id)?.name ?? "Removed group" },
          permission: grant.permission,
        };
      }),
    };
  },
});

const grantPermission = defineTool({
  name: "grant_permission",
  title: "Grant permission",
  description:
    "Give an existing Nimbus user (by email) or group (by name) read, write, or admin access to a file or folder you administer, including everything inside it. Granting again replaces that subject's permission on this path. Confirm with the user before widening access.",
  scope: McpScope.share,
  annotations: idempotentChange,
  input: z.object({
    path: pathInput,
    subject: z.discriminatedUnion("type", [
      z.object({ type: z.literal("user"), email: z.string().email() }),
      z.object({ type: z.literal("group"), name: z.string().min(1).max(100) }),
    ]),
    permission: permissionSchema,
  }),
  output: z.object({ path: z.string(), permission: permissionSchema }),
  async run({ caller }, input) {
    const target = await safePath(input.path);
    let id: string | undefined;
    if (input.subject.type === "user") {
      const email = input.subject.email.toLowerCase();
      id = (await caller.access.people()).find((person) => person.email.toLowerCase() === email)?.id;
    } else {
      const name = input.subject.name;
      id = (await caller.access.groups()).find((group) => group.name === name)?.id;
    }
    if (id === undefined)
      throw toolFailure("NOT_FOUND", `No active Nimbus ${input.subject.type} matches that ${input.subject.type === "user" ? "email" : "name"}. Nothing was shared. Ask an administrator to create it first.`);
    await caller.access.grant({ path: target.relative, subject: { type: input.subject.type, id }, permission: input.permission });
    return { path: target.relative, permission: input.permission };
  },
});

const revokePermission = defineTool({
  name: "revoke_permission",
  title: "Revoke permission",
  description: "Remove a direct grant from a file or folder you administer. Access the subject inherits from parent folders or groups remains.",
  scope: McpScope.share,
  annotations: { ...destructive, idempotentHint: true },
  input: z.object({ path: pathInput, grantId: z.string().min(1) }),
  output: z.object({ revoked: z.boolean() }),
  async run({ caller }, input) {
    await caller.access.revoke({ path: input.path, id: input.grantId });
    return { revoked: true };
  },
});

export const sharingTools = [listLinks, createLink, revokeLink, listPermissions, grantPermission, revokePermission];
