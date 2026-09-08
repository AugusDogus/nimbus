# Nimbus web app

This workspace contains the Next.js interface and the Bun server. Follow [the repository README](../../README.md) for setup, deployment, configuration, sharing semantics, and backups.

Run commands from the repository root unless noted:

```bash
bun run setup
bun dev
```

The root scripts run this workspace with `apps/web` as its working directory, so Bun loads `apps/web/.env`. `bun run start` uses the same custom server in production after `bun run build`. Do not launch with `next start`, which bypasses migrations, WebDAV dispatch, and scheduled cleanup.

## Code layout

- `app/(files)`: authenticated file browser, shared and saved items, and trash.
- `app/(settings)/settings`: dedicated settings sidebar with Appearance, Account, WebDAV, and admin-only Users & groups pages.
- `app/s/[token]`: public file and folder sharing pages.
- `app/api`: authentication, tRPC, resumable uploads, downloads, thumbnails, public shares, and health endpoint.
- `server/start.ts`: startup migrations, Next.js and WebDAV routing, cleanup scheduling, and process shutdown.
- `server/db`: Drizzle schema and the SQLite connection.
- `server/drive-store.ts`: persistent accounts, grants, groups, shares, trash records, bookmarks, and app passwords.
- `server/webdav.ts`: WebDAV request handling.
- `server/maintenance.ts`: trash, upload staging, and thumbnail retention.
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
bun test
bun run typecheck
bun run lint
bun run build
bun playwright install chromium
bun run test:e2e
```

The browser tests create and remove their own temporary database and files. Keep port 3100 available. Production builds and browser tests must run sequentially because they share the Next.js build directory.
