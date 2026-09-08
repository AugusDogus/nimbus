# Nimbus

Nimbus is a self-hosted file manager with account and group sharing, public download links, and WebDAV access. Files stay on your filesystem. Accounts, permissions, links, and preferences are stored in SQLite.

## Features

- Browse folders in list or grid views with sorting, breadcrumbs, and live updates.
- Upload files with resumable transfers, create folders, rename, move, download, and restore deleted items.
- Preview images, PDF, text, audio, and video. Download folders as ZIP archives.
- Search filenames and keep starred and recently opened items.
- Share files and folders with existing users or groups using read, write, or sharing-management permissions.
- Create read-only public links with optional passwords and expiration, view download counts, and revoke links.
- Manage users, groups, account roles, disabled accounts, and password resets from the administrator page.
- Connect WebDAV clients with individually revocable app passwords.

## Local setup

Use Bun 1.3.5 or newer. Run these commands from the repository root:

```bash
bun install --frozen-lockfile
bun run setup
bun dev
```

Open [http://localhost:3000/signup](http://localhost:3000/signup) and create the first account. It becomes the server administrator. Public registration closes after that account is created. Add other accounts from **Administration**, then share a folder with them.

`bun run setup` generates `apps/web/.env` with a random auth secret and creates a local data directory. It preserves an existing `.env`. Database migrations run before the server accepts requests.

## Docker deployment

The included Compose configuration builds Nimbus locally and persists all default storage in the `nimbus-data` volume. Docker Engine with Compose is required.

From the repository root, create a `.env` file for Compose containing:

```dotenv
BETTER_AUTH_SECRET=REPLACE_WITH_RANDOM_SECRET
BETTER_AUTH_URL=http://localhost:3000
```

Generate the secret with `openssl rand -base64 32` and paste its output as the value. Keep this file private and keep the same secret across restarts.

```bash
docker compose up -d --build
docker compose logs -f nimbus
```

Open [http://localhost:3000/signup](http://localhost:3000/signup) to create the administrator. Compose binds port 3000 to the host's loopback interface. For remote access, put an HTTPS reverse proxy in front of it and set `BETTER_AUTH_URL` to the public origin, for example `https://files.example.com`. The proxy must preserve the request host and forwarded protocol, allow WebDAV methods, and permit your intended upload sizes and transfer durations. Disable buffering for the live event stream. Serve Nimbus at the origin root, not under a URL prefix.

The container runs as the unprivileged `bun` user. A host directory can replace the named volume if it is writable by that user. Use one Nimbus process per data root, on a local filesystem. Locks, live events, and mutation coordination are maintained within that process.

## Run without Docker

```bash
bun install --frozen-lockfile
bun run setup
bun run build
bun run start
```

Set the deployment values in `apps/web/.env` before startup. The Bun custom server is required for startup migrations, WebDAV methods, and retention cleanup. Use `bun run start`, not `next start`. The process listens on all interfaces; put your service manager and HTTPS proxy in front of it as appropriate.

## Configuration

| Variable                      | Purpose                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`          | Required random secret of at least 32 characters. Protect it and keep it across restarts.                                           |
| `BETTER_AUTH_URL`             | Public origin, including scheme and port when needed. Defaults locally to `http://localhost:3000`.                                  |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Optional comma-separated additional trusted origins. Compose defaults this to `BETTER_AUTH_URL`.                                    |
| `NIMBUS_DATA_ROOT`            | Filesystem directory to manage. Local default: `apps/web/data` when launched with the supplied scripts. Container default: `/data`. |
| `DATABASE_URL`                | Optional SQLite URL. Default: `file:<data root>/.nimbus/db.sqlite`. Use an absolute path when overriding it.                        |
| `PORT`                        | Listening port, default `3000`. Update the public origin and proxy when changing it.                                                |

The reserved `.nimbus` directory contains the database, trash, temporary uploads, and thumbnail cache. Nimbus never exposes it through file browsing or sharing. Symbolic links and special files are excluded. Nimbus needs read and write access to the data root; other local programs with access to that directory remain outside Nimbus's permission controls.

## Sharing and permissions

Server administrators have access to the entire drive. New ordinary accounts start with no file access. Administrators can share a folder or the drive root; recipients find it in **Shared with me**.

| Permission | Access                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Read       | Browse, preview, and download the item and its contents.                                                                                |
| Write      | Read access plus uploads, folder creation, file changes, and moving items to trash.                                                     |
| Admin      | Write access plus managing permissions and public links for that subtree. Moving or copying a folder requires this level on its source. |

Permissions apply to descendants and are additive. User and group grants combine using the strongest matching permission. A narrower grant cannot reduce access inherited from a parent. Remove the parent or group grant to remove that inherited access. A folder administrator is distinct from a server administrator.

Public links grant read-only access and work without a Nimbus account. A link to a folder also exposes its descendants. Password-protected links unlock for one hour in that browser. Revoking or expiring a link prevents future requests; downloaded copies remain with the recipient. Links also stop working when their creator loses sharing permission or is disabled.

Renaming, moving, or trashing an item removes its public links, direct grants, and bookmarks, including those on descendants. Its destination's inherited permissions apply after a move. Restoring from trash does not recreate old links or direct grants.

## Trash and retention

Deleted items remain in **Trash** for 30 days. Users see their own deleted items; server administrators can manage all trash. Restoring requires write access at the original location, an existing parent folder, and an unused filename. Permanent deletion cannot be undone.

Cleanup runs at startup and hourly. It permanently removes expired trash, upload staging files inactive for more than 24 hours, and thumbnails older than 30 days. A completed upload keeps its staging copy temporarily so interrupted completion requests can be retried. Allow storage headroom for these copies. Trash is a recovery convenience, not a backup.

## WebDAV

In **Settings**, create an app password and save it when shown. Configure the client with:

- URL: `https://your-nimbus-server/dav/`
- Username: your Nimbus account email
- Password: the generated app password

Your normal file permissions apply. Revoking the app password immediately blocks subsequent requests from that client. Use HTTPS for remote access because WebDAV sends credentials using HTTP Basic authentication.

Supported operations are `OPTIONS`, `GET`, `HEAD`, `PROPFIND`, `PUT`, `MKCOL`, `DELETE`, `MOVE`, `COPY`, `LOCK`, and `UNLOCK`. `PROPFIND` supports depth `0` and `1`. Deletes go to trash. File downloads support single byte ranges.

WebDAV is intended for basic file access, not a complete distributed collaboration protocol. `MOVE` and `COPY` refuse to overwrite existing destinations. Locks are exclusive, last one hour, and are cleared on restart. Persistent custom properties (`PROPPATCH`), infinite-depth listings, and shared locks are unsupported. Test the operations your chosen client needs before relying on its editing or synchronization workflow.

## Backups and upgrades

Stop Nimbus before taking a filesystem backup, then copy the entire data root, including `.nimbus`, plus the environment configuration. If `DATABASE_URL` points elsewhere, back up that SQLite database and any journal files too. Restore those together while Nimbus is stopped. Do not delete the Compose volume when stopping the service.

To upgrade, back up first, update the checkout, then rebuild and restart:

```bash
docker compose up -d --build
```

For a local installation, reinstall dependencies with the lockfile, build, and restart. Startup applies committed migrations automatically. To apply them explicitly:

```bash
bun run --cwd apps/web db:migrate
```

Existing installations from the original file manager should retain their `DATABASE_URL` and `NIMBUS_DATA_ROOT`. The original default database was `apps/web/nimbus.db`; set `DATABASE_URL=file:/absolute/path/to/apps/web/nimbus.db` to keep using it. The upgrade preserves existing accounts and promotes the oldest account to administrator. Other accounts must receive file grants before they can access files. Do not use `db:push` as an upgrade procedure.

`GET /api/health` reports that the HTTP server is available. It is not a storage-capacity or backup check. Startup fails when configuration or migrations cannot be applied; inspect the process or Compose logs for the failing operation.

## Development and verification

```bash
bun test
bun run typecheck
bun run lint
bun run build
bun playwright install chromium
bun run test:e2e
```

Unit tests cover path confinement, permissions, file operations, migrations, retention, and caches. Playwright tests use isolated temporary storage and accounts on port 3100 with desktop and mobile Chromium projects. Do not run a production build while the development test server is running. CI runs these checks and retains failed browser-test artifacts.

See [the web app README](apps/web/README.md) for the code layout and database development commands.
