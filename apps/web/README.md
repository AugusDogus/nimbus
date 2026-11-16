# Nimbus web app

This workspace contains the Next.js interface and the Bun server. Follow [the repository README](../../README.md) for setup, deployment, configuration, sharing semantics, and backups.

Nimbus pins Bun 1.4.4. To upgrade it, change the root `package.json` `packageManager`, the `bun-version` in `.github/workflows`, and the `Dockerfile` base image tag and digest together.

Run commands from the repository root unless noted:

```bash
bun run setup
bun dev
```

The root scripts run this workspace with `apps/web` as its working directory, so Bun loads `apps/web/.env`. `bun run start` uses the same custom server in production after `bun run build`. Do not launch with `next start`, which bypasses migrations, WebDAV dispatch, and scheduled cleanup.

## Code layout

- `app/(files)`: authenticated file browser, shared and saved items, and trash.
- `app/(settings)/settings`: dedicated settings sidebar with Appearance, Account, WebDAV, MCP, and the admin-only Users & groups and Audit log pages.
- `app/s/[token]`: public file and folder sharing pages.
- `app/r/[token]`: public upload page for file requests.
- `app/api`: authentication, tRPC, resumable uploads (signed-in and file requests), downloads, versions, thumbnails, public shares, backups, and health endpoints.
- `server/start.ts`: startup migrations, Next.js and WebDAV routing, cleanup scheduling, and process shutdown.
- `server/db`: Drizzle schema and the SQLite connection.
- `server/drive-store.ts`: persistent accounts, grants, groups, shares, file requests, versions, homes, WebDAV properties, trash records with their suspended links and grants, bookmarks, and app passwords.
- `server/webdav.ts`: WebDAV request handling.
- `server/security-headers.ts`, `server/client-ip.ts`, `server/rate-limit.ts`: response hardening, trusted-proxy client addresses, and in-memory rate limits.
- `server/audit-log.ts` and `../../packages/api/src/audit.ts`: the audit log store and the `recordAudit` function for recording events from any server code.
- `lib/auth.ts`, `lib/auth-security.ts`, `lib/auth-audit.ts`: Better Auth configuration, Nimbus account-security endpoints, and sign-in auditing.
- `server/maintenance.ts`: trash, upload staging, file request reservation, version, and thumbnail retention.
- `server/backup.ts`: daily online database backups.
- `server/upload-publish.ts`: the staging store, publish and replace step, and resume recovery shared by both tus endpoints.
- `../../packages/api/src/file-content.ts`, `../../packages/api/src/file-versions.ts`: the one staged-write commit used by WebDAV `PUT`, the editor, and MCP, and `FileVersions.commitReplacement`, which every content replacement goes through.
- `server/thumbnails.ts`, `server/thumbnail-renderers.ts`: content-addressed thumbnail cache with bounded concurrency, and the bounded `pdftoppm` and FFmpeg subprocesses.
- `server/search.worker.ts`, `server/search-bridge.ts`: the filename index runs in a Bun worker, fed by the file watcher and reconciled every 30 minutes. The index itself is `../../packages/api/src/search-index.ts`.
- `app/(files)/[[...path]]/preview`: preview renderers. Each renderer, the Markdown parser, the highlighter worker, and each highlighting grammar is a separate chunk loaded only when a file of that kind is opened.
- `server/mcp`: MCP endpoint wiring, its OAuth 2.1 authorization server (`server/mcp/oauth`), and download links. Tool definitions live in `../../packages/api/src/mcp-*.ts`.
- `app/oauth`, `app/.well-known`: MCP authorization, consent, and discovery routes.
- `../../packages/api/src`: typed API routers, permission checks, safe paths, and filesystem operations shared with the server.
- `drizzle`: committed database migrations and schema snapshots.
- `e2e`: Playwright tests and fixtures, started using `../../scripts/e2e-server.ts`.

## Themes

Settings → Appearance separates the color scheme (System, Light, Dark) from the theme used for each scheme. Selecting or importing a theme preserves the current color scheme.

The built-in library includes Nimbus plus T3 Chat, Grove, Ocean, Ember, and Iris, adapted from T3 Code under the MIT license. Each palette has independently selectable light and dark variants.

Use **Add theme** to import VS Code color theme `.json` or `.jsonc` files, or search Open VSX and add an extension's color themes. Imported colors apply to Nimbus's surfaces and controls. Syntax token colors are not used. Community imports resolve theme `include` files within the extension; standalone files with includes must first be exported as a complete color theme from VS Code.

Themes and selections are stored in this browser and restored on reload. Removing a selected theme restores Nimbus's default palette for that scheme. Theme files are limited to 1 MB, extension downloads to 20 MB, and saved themes to 100.

## Database changes

Edit the relevant schema under `server/db`, then generate and inspect the migration:

```bash
bun run --cwd apps/web db:generate
bun run --cwd apps/web db:migrate
```

Commit both the generated SQL and Drizzle metadata. Startup applies the same migrations before listening. Preserve custom SQL triggers when changing account tables; they prevent removing the final active administrator. Migration tests cover both a fresh database and the original pre-migration schema.

`db:studio` opens the configured database for inspection. `db:push` is available only for disposable development databases; it bypasses migration history and must not be used for production upgrades.

## Verification

```bash
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
bun playwright install chromium
bun run test:e2e
```

Formatting and linting run from the repository root over every workspace; see [Development and verification](../../README.md#development-and-verification) for the tools and their configuration.

The browser tests create and remove their own temporary database and files. Keep port 3100 available, or set `NIMBUS_E2E_PORT` to run on another port. Production builds and browser tests must run sequentially because they share the Next.js build directory.
