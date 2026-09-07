import { describe, expect, it } from "bun:test";
import { useQuery } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import Providers from "../app/providers";

function AccountFiles({ filename }: { filename: string }) {
  const query = useQuery({
    queryKey: ["request-isolation"],
    queryFn: async () => filename,
    initialData: filename,
  });
  return <span>{query.data}</span>;
}

describe("server-rendered query isolation", () => {
  it("uses each request's initial data instead of a previous account's cached files", () => {
    const render = (filename: string) =>
      renderToString(
        <Providers>
          <AccountFiles filename={filename} />
        </Providers>,
      );
    expect(render("first-account-private.txt")).toContain(
      "first-account-private.txt",
    );
    const second = render("second-account-private.txt");
    expect(second).toContain("second-account-private.txt");
    expect(second).not.toContain("first-account-private.txt");
  });
});
