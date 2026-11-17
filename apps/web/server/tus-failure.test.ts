import { expect, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { tusFailure } from "./tus-failure";

test("passes expected failures through and hides internal error messages", () => {
  expect(tusFailure({ status_code: 409, body: "Offset mismatch." })).toEqual({
    status_code: 409,
    body: "Offset mismatch.",
  });
  expect(
    tusFailure(new TRPCError({ code: "FORBIDDEN", message: "No access." })),
  ).toEqual({ status_code: 403, body: "No access." });
  const internal = tusFailure(
    new Error("EACCES: permission denied, open '/srv/nimbus/data/.nimbus/x'"),
  );
  expect(internal.status_code).toBe(500);
  expect(internal.body).not.toContain("/srv/nimbus");
  expect(internal.body).toContain("upload");
});
