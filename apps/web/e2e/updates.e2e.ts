import { expect, type Page, type Route } from "@playwright/test";
import { test } from "./helpers";

/**
 * Settings, Administration, Updates, against a stubbed supervisor: the browser suite runs its
 * server on its own, so the page's requests to /api/admin/updates are answered here, in the
 * shapes the server relays from the supervisor. The real path is checked last.
 */
type Panel = Record<string, unknown>;

const panel = (overrides: Panel = {}): Panel => ({
  running: { name: "built-in", sequence: 100, commit: "c".repeat(40) },
  channel: "edge",
  source: {
    kind: "url",
    url: "https://updates.example.test/",
    origin: "configured",
  },
  unavailable: null,
  lastCheck: { at: "2026-11-24T09:00:00.000Z", outcome: "up to date" },
  available: null,
  previous: null,
  schedule: { mode: "notify", hour: 4 },
  timeZone: "UTC",
  operation: null,
  lastOutcome: null,
  ...overrides,
});

const offer = {
  kind: "offer",
  build: {
    sequence: 101,
    commit: "d".repeat(40),
    channel: "edge",
    publishedAt: "2026-11-24T10:00:00.000Z",
    repository: "example/nimbus",
  },
  notes: Array.from({ length: 10 }, (_, index) => ({
    commit: String(index).repeat(40),
    subject: `Change number ${index + 1}`,
  })),
  message: "Nimbus build 101 is available.",
};

/** Answer the update endpoint with `respond`, recording what was posted. */
async function stub(
  page: Page,
  respond: (
    method: string,
    body: unknown,
  ) => { status?: number; json?: unknown; lines?: unknown[] },
) {
  const posted: unknown[] = [];
  await page.route("**/api/admin/updates", async (route: Route) => {
    const request = route.request();
    const body: unknown =
      request.method() === "POST" ? request.postDataJSON() : null;
    if (request.method() === "POST") posted.push(body);
    const answer = respond(request.method(), body);
    if (answer.lines)
      return route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: answer.lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
      });
    return route.fulfill({ status: answer.status ?? 200, json: answer.json });
  });
  return posted;
}

const section = (page: Page) => page.getByRole("region", { name: "Updates" });

test("up to date, a check finds an update with its changes, and Update now installs it", async ({
  page,
}) => {
  let state = panel();
  const posted = await stub(page, (method, body) => {
    if (method === "GET") return { json: { panel: state } };
    if (body && typeof body === "object" && "action" in body) {
      if (body.action === "check") {
        state = panel({ available: offer });
        return { json: { panel: state } };
      }
      if (body.action === "install") {
        state = panel({
          running: {
            name: "edge-101-dddddddddddd",
            sequence: 101,
            commit: "d".repeat(40),
          },
          previous: null,
          lastOutcome: {
            kind: "install",
            by: "administrator",
            ok: true,
            release: "edge-101-dddddddddddd",
            message: "Updated to edge-101-dddddddddddd.",
            at: "2026-11-24T10:05:00.000Z",
          },
        });
        return {
          lines: [
            { kind: "started", release: null, readyTimeoutSeconds: 300 },
            {
              kind: "progress",
              seconds: 2,
              phase: "handing-over",
              starting: null,
            },
            {
              kind: "done",
              ok: true,
              report: {
                from: "built-in",
                to: "edge-101-dddddddddddd",
                readyMs: 900,
                draining: null,
                fullRestart: null,
              },
            },
          ],
        };
      }
    }
    return { status: 400, json: { error: "unexpected" } };
  });
  await page.goto("/settings/admin");
  const updates = section(page);
  await expect(updates.getByText("Nimbus is up to date")).toBeVisible();
  await expect(updates.getByText("Build 100 (ccccccc) · edge")).toBeVisible();
  await updates.getByRole("button", { name: "Check now" }).click();
  await expect(
    updates.getByText("Build 101 (ddddddd) is available"),
  ).toBeVisible();
  const changes = updates.getByRole("list", { name: "Changes in this update" });
  await expect(changes.getByRole("listitem")).toHaveCount(7);
  await expect(changes).toContainText("and 4 more");
  await updates.getByRole("button", { name: "Update now" }).click();
  await expect(
    updates.getByText("Updated to build 101 (ddddddd)"),
  ).toBeVisible();
  await expect(
    updates.getByRole("button", { name: "Load the new version" }),
  ).toBeVisible();
  expect(posted).toEqual([{ action: "check" }, { action: "install" }]);
});

test("an install under way shows the supervisor's progress, and a failed one its reason", async ({
  page,
}) => {
  let state = panel({
    operation: {
      kind: "install",
      by: "administrator",
      startedAt: "2026-11-24T10:00:00.000Z",
      stage: "handing-over",
      seconds: 30,
      starting: { release: "edge-101-dddddddddddd", pid: 4242 },
      readyTimeoutSeconds: 300,
    },
  });
  await stub(page, () => ({ json: { panel: state } }));
  await page.goto("/settings/admin");
  const updates = section(page);
  await expect(updates.getByText("Updating Nimbus")).toBeVisible();
  await expect(updates.getByText("30 s of at most 300 s")).toBeVisible();
  await expect(
    updates.getByRole("progressbar", {
      name: "Starting the new version beside the running one",
    }),
  ).toBeVisible();
  state = panel({
    available: offer,
    lastOutcome: {
      kind: "install",
      by: "administrator",
      ok: false,
      release: "built-in",
      message:
        "The bundle of release edge-101-dddddddddddd arrived cut short. Nothing was installed; check again later.",
      at: "2026-11-24T10:01:00.000Z",
    },
  });
  await expect(updates.getByRole("alert")).toContainText("arrived cut short", {
    timeout: 10_000,
  });
  await expect(
    updates.getByText("The last update did not happen"),
  ).toBeVisible();
});

test("updates that are off say why and how to turn them on, and offer nothing to press", async ({
  page,
}) => {
  await stub(page, () => ({
    json: {
      panel: panel({
        unavailable:
          "In-app updates are off: every Nimbus process runs as one user (as when the container is started with --user). To turn them on, start the container as root and give the user with PUID and PGID instead of --user.",
      }),
    },
  }));
  await page.goto("/settings/admin");
  const updates = section(page);
  await expect(
    updates.getByText("Updates are off", { exact: true }),
  ).toBeVisible();
  await expect(updates).toContainText("instead of --user");
  await expect(updates.getByRole("button", { name: "Check now" })).toHaveCount(
    0,
  );
  await expect(updates.getByRole("button", { name: "Roll back" })).toHaveCount(
    0,
  );
});

test("a release that needs a newer image says which to pull", async ({
  page,
}) => {
  await stub(page, () => ({
    json: {
      panel: panel({
        available: {
          ...offer,
          kind: "needs-newer-image",
          message:
            "Nimbus build 101 is available but needs Bun 1.5.0. Pull ghcr.io/example/nimbus:edge and recreate the container to get it.",
        },
      }),
    },
  }));
  await page.goto("/settings/admin");
  const updates = section(page);
  await expect(updates.getByText("needs a newer image")).toBeVisible();
  await expect(updates).toContainText("Pull ghcr.io/example/nimbus:edge");
  await expect(updates.getByRole("button", { name: "Update now" })).toHaveCount(
    0,
  );
});

test("a rollback is confirmed first, and the schedule offers a quiet hour", async ({
  page,
}) => {
  let state = panel({
    running: {
      name: "edge-101-dddddddddddd",
      sequence: 101,
      commit: "d".repeat(40),
    },
  });
  const posted = await stub(page, (method, body) => {
    if (
      method === "POST" &&
      body &&
      typeof body === "object" &&
      "action" in body
    ) {
      if (body.action === "rollback")
        return {
          lines: [
            {
              kind: "done",
              ok: true,
              report: {
                from: "edge-101-dddddddddddd",
                to: "built-in",
                readyMs: 800,
                draining: null,
                fullRestart: null,
              },
            },
          ],
        };
      if (body.action === "schedule" && "mode" in body && "hour" in body) {
        state = panel({
          ...state,
          schedule: { mode: body.mode, hour: body.hour },
        });
        return { json: { panel: state } };
      }
    }
    return { json: { panel: state } };
  });
  await page.goto("/settings/admin");
  const updates = section(page);
  await updates.getByRole("button", { name: "Roll back" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Roll back Nimbus?" });
  await expect(dialog).toContainText("the image's own release");
  await dialog.getByRole("button", { name: "Roll back" }).click();
  await expect(dialog).toHaveCount(0);
  await updates.getByRole("combobox", { name: "Automatic updates" }).click();
  await page.getByRole("option", { name: "Install at a quiet hour" }).click();
  await expect(
    updates.getByRole("combobox", { name: "Quiet hour" }),
  ).toBeVisible();
  await expect(updates).toContainText("server's time zone (UTC)");
  expect(posted).toEqual([
    { action: "rollback" },
    { action: "schedule", mode: "install", hour: 4 },
  ]);
});

test("without a supervisor the page says so, and only an administrator from Nimbus may change anything", async ({
  page,
  browser,
}) => {
  await page.goto("/settings/admin");
  await expect(section(page)).toContainText("runs without its supervisor");
  const forged = await page.request.post("/api/admin/updates", {
    headers: { origin: "https://attacker.example" },
    data: { action: "install" },
  });
  expect(forged.status()).toBe(403);
  const anonymous = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    expect((await anonymous.request.get("/api/admin/updates")).status()).toBe(
      401,
    );
  } finally {
    await anonymous.close();
  }
});

test("the build that runs is never shown as available", async ({ page }) => {
  await stub(page, () => ({
    json: {
      panel: panel({
        running: {
          name: "edge-101-dddddddddddd",
          sequence: 101,
          commit: "d".repeat(40),
        },
        available: offer,
      }),
    },
  }));
  await page.goto("/settings/admin");
  const updates = section(page);
  await expect(updates.getByText("Nimbus is up to date")).toBeVisible();
  await expect(
    updates.getByText("Build 101 (ddddddd) is available"),
  ).toHaveCount(0);
  await expect(updates.getByRole("button", { name: "Update now" })).toHaveCount(
    0,
  );
});
