import { afterAll, describe, expect, it } from "bun:test";
import { TextContent } from "./text-content";

const files = new Map<string, Uint8Array<ArrayBuffer>>([
  ["/utf8", new TextEncoder().encode("café")],
  // "café" in Windows-1252: é is the single byte 0xE9, invalid as UTF-8.
  ["/latin1", new Uint8Array([0x63, 0x61, 0x66, 0xe9])],
  ["/bom", new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])],
]);

const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    const bytes = files.get(new URL(request.url).pathname);
    return bytes
      ? new Response(bytes, { headers: { ETag: '"tag"' } })
      : new Response(null, { status: 404 });
  },
});
afterAll(() => server.stop(true));

const load = (name: string) => TextContent.load(`${server.url.origin}${name}`);

describe("TextContent.load", () => {
  it("decodes UTF-8 text as editable", async () => {
    expect(await load("/utf8")).toMatchObject({
      type: "text",
      text: "café",
      encoding: "utf-8",
    });
  });

  it("marks text that is not valid UTF-8, so saving cannot replace its bytes", async () => {
    expect(await load("/latin1")).toMatchObject({
      type: "text",
      text: "caf�",
      encoding: "other",
    });
  });

  it("keeps a byte order mark, so saving writes it back", async () => {
    const content = await load("/bom");
    expect(content).toMatchObject({ type: "text", encoding: "utf-8" });
    expect(content.type === "text" && content.text).toBe("﻿hi");
  });
});
