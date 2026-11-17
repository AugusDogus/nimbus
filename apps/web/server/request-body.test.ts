import { expect, test } from "bun:test";
import { RequestBody } from "./request-body";

/** A streamed body of `chunks` 64 KB chunks that records how many were pulled. */
function endless(chunks: number) {
  const pulled = { count: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.count === chunks) return controller.close();
      pulled.count++;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  return { pulled, body };
}

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/share/x", {
    method: "POST",
    body,
    headers,
  });

test("reads a body under the cap", async () => {
  const body = await RequestBody.read(post('{"password":"x"}'), 1024);
  expect(body.kind).toBe("read");
  if (body.kind === "read")
    expect(new TextDecoder().decode(body.bytes)).toBe('{"password":"x"}');
});

test("stops reading a streamed body as soon as it passes the cap", async () => {
  const { pulled, body } = endless(16_000);
  expect(await RequestBody.read(post(body), 100 * 1024)).toEqual({
    kind: "too_large",
    maxBytes: 100 * 1024,
  });
  expect(pulled.count).toBeLessThan(5);
});

test("refuses a declared length over the cap without reading", async () => {
  const { pulled, body } = endless(16_000);
  const request = new Request("http://localhost/x", {
    method: "POST",
    body,
    headers: { "content-length": String(1024 * 1024 * 1024) },
  });
  expect((await RequestBody.read(request, 1024)).kind).toBe("too_large");
  expect(pulled.count).toBeLessThan(2);
});

test("capped handlers see the buffered body and oversized requests get 413", async () => {
  const handler = RequestBody.capped(1024, async (request: Request) =>
    Response.json(await request.json()),
  );
  expect(await (await handler(post('{"a":1}'))).json()).toEqual({ a: 1 });
  const refused = await handler(post(endless(100).body));
  expect(refused.status).toBe(413);
  const get = await RequestBody.capped(
    1,
    () => new Response("ok"),
  )(new Request("http://localhost/x"));
  expect(await get.text()).toBe("ok");
});
