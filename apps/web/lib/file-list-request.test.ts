import { describe, expect, test } from "bun:test";
import { fileListRequest } from "./file-list-request";

describe("fileListRequest", () => {
  test("is the URL tRPC's batch link sends for one listing query", () => {
    expect(fileListRequest("", false)).toBe(
      "/api/trpc/files.list?batch=1&input=%7B%220%22%3A%7B%22includeStats%22%3Afalse%7D%7D",
    );
    expect(
      decodeURIComponent(
        fileListRequest("a b/100%", true).split("input=")[1] ?? "",
      ),
    ).toBe('{"0":{"path":"a b/100%","includeStats":true}}');
  });
});
