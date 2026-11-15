<p align="center">
  <img src="docs/assets/nimbus-icon.svg" alt="Nimbus logo" width="120" height="120" />
</p>

<h1 align="center">Nimbus</h1>

<p align="center">A self-hosted file manager with account and group sharing, public download links, and WebDAV access.</p>

Files stay on your filesystem. Accounts, permissions, links, and preferences are stored in SQLite.

## Features

- Browse folders in list or grid views with sorting, breadcrumbs, and live updates.
- Upload files with resumable transfers, create folders, rename, move, download, and restore deleted items.
- Preview images, PDF, text, audio, and video. Download folders as ZIP archives.
- Search filenames and keep starred and recently opened items.
- Share files and folders with existing users or groups using read, write, or sharing-management permissions.
- Create read-only public links with optional passwords and expiration, view download counts, and revoke links.
- Manage users, groups, account roles, disabled accounts, and password resets from Settings → Administration.
- Connect WebDAV clients with individually revocable app passwords.
- Choose built-in light and dark themes, import VS Code themes, or find community themes on Open VSX.

## Local setup

Use Bun 1.4.1 or newer. Run these commands from the repository root:

```bash
bun install --frozen-lockfile
bun run setup
bun dev
```

Open [http://localhost:3000/signup](http://localhost:3000/signup) and create the first account. It becomes the server administrator. Public registration closes after that account is created. Add other accounts from **Settings → Administration → Users & groups**, then share a folder with them.

`bun run setup` generates `apps/web/.env` with a random auth secret and creates a local data directory. It preserves an existing `.env`. Database migrations run before the server accepts requests.

## Docker deployment

The included Compose configuration builds Nimbus locally and persists files in `nimbus-data` and application state in `nimbus-config`. Docker Engine with Compose is required.

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

The server runs as an unprivileged user, by default UID and GID 1000. Set `PUID` and `PGID` to the numeric owner of your host directories, and Nimbus creates files as that user. `UMASK` (default `022`) sets the permissions of new files; `002` makes them group-writable. The container starts as root only to apply these settings, then drops privileges before the server starts. At startup it takes ownership of the config root and the reserved `/data/.nimbus` folder, which contain only Nimbus state, and of the `/data` directory itself; it never changes the ownership of your files. If you start the container with `--user` instead, these variables are ignored and the mounts must already be writable by that user. Persist both `/data` (managed files, trash, upload staging) and `/config` (database and thumbnail cache). Use one Nimbus process per data root, on a local filesystem. Locks, live events, and mutation coordination are maintained within that process.

### Published image

The Docker workflow builds the Dockerfile for `linux/amd64` and `linux/arm64` on native runners for every PR, without publishing. Pushes to `main` and version tags such as `v1.2.3` publish a multi-platform image to GitHub Container Registry with signed build provenance. Every build uses the latest Bun base image.

- `ghcr.io/augusdogus/nimbus:1.2.3` is published from the `v1.2.3` tag.
- `ghcr.io/augusdogus/nimbus:latest` tracks the most recently published stable release.
- `ghcr.io/augusdogus/nimbus:edge` tracks builds from `main` for testing unreleased changes.
- Prerelease tags such as `v1.3.0-beta.1` publish `:1.3.0-beta.1` without updating `:latest`.

To use a published image, replace `build: .` in `compose.yaml` with `image: ghcr.io/augusdogus/nimbus:latest`, keeping the environment and both volume mappings. Then run:

```bash
docker compose pull
docker compose up -d --no-build
```

Publishing uses the workflow's `GITHUB_TOKEN`; no registry secret needs to be configured. After the first publish, the package owner should set its visibility to **Public** in GitHub's package settings to allow pulls without signing in. New GHCR packages default to private. See [GitHub's registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

### Unraid

Set `PUID=99` and `PGID=100`, Unraid's `nobody:users` owner for shares, so files created by Nimbus are accessible over SMB and to other containers. Use these container path mappings:

| Host path | Container path | Access |
| --- | --- | --- |
| `/mnt/user/data` | `/data` | Read/write |
| `/mnt/user/appdata/nimbus` | `/config` | Read/write |

Keep the appdata share on your SSD pool. `/mnt/cache/appdata/nimbus` can replace the appdata host path when `cache` is your pool name and the directory resides entirely there. For SSD uploads followed by HDD storage, configure the `data` share with the SSD pool as primary storage, the array as secondary storage, and Mover set from pool to array.

Keep `.nimbus/uploads` and `.nimbus/trash` inside the single `/data` mount. Separate mounts can prevent same-filesystem operations, even when their host paths reside on the same disk. Unraid controls physical placement; Nimbus does not move files between the cache pool and array. Existing installations should follow [Storage migration](#storage-migration) before switching to `/config`.

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
| `NIMBUS_CONFIG_ROOT`          | Database and thumbnail cache directory. Local default: `<data root>/.nimbus`. Container default: `/config`. |
| `DATABASE_URL`                | Optional SQLite URL, overriding the config root for the database only. Default: `file:<config root>/db.sqlite`. Use an absolute path when overriding it. |
| `PORT`                        | Listening port, default `3000`. Update the public origin and proxy when changing it.                                                |
| `PUID`, `PGID`                | Container only. Numeric user and group the server runs as, default `1000`. |
| `UMASK`                       | Container only. Permission mask for new files and folders, default `022`. |

The reserved `<data root>/.nimbus` directory contains trash and temporary uploads. Without a separate config root, it also contains the database and thumbnail cache. Nimbus never exposes `.nimbus` through file browsing or sharing. Keep a separate config root outside the browsable data root. Symbolic links and special files are excluded. Nimbus needs read and write access to both roots; other local programs with access to those directories remain outside Nimbus's permission controls.

## Settings

Open the settings cog beside **Trash** to switch to the settings sidebar:

- **Appearance:** choose System, Light, or Dark mode and a separate theme for each color scheme. **Add theme** supports VS Code theme files and Open VSX community search. Themes and selections are saved in this browser. See [theme details and import limits](apps/web/README.md#themes).
- **Account:** view your name and email, and change your password. Changing it signs out other browser sessions; WebDAV app passwords remain active.
- **WebDAV:** copy your server address and username, create a password for each device, and revoke passwords you no longer need.
- **Administration → Users & groups** (server administrators only): create accounts, manage group membership, and grant drive access. Each user's action menu contains password reset, administrator role, and enable/disable controls.

Use **Back to files** to return to the drive. Active uploads continue while you browse Settings.

## Sharing and permissions

Server administrators have access to the entire drive. New ordinary accounts start with no file access. Administrators can share a folder or the drive root; recipients find it under **Shared → Shared with me**.

| Permission | Access                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Read       | Browse, preview, and download the item and its contents.                                                                                |
| Write      | Read access plus uploads, folder creation, file changes, and moving items to trash.                                                     |
| Admin      | Write access plus managing permissions and public links for that subtree. Moving or copying a folder requires this level on its source. |

Permissions apply to descendants and are additive. User and group grants combine using the strongest matching permission. A narrower grant cannot reduce access inherited from a parent. Remove the parent or group grant to remove that inherited access. A folder administrator is distinct from a server administrator.

Manage links you created under **Shared → Public links**.

Public links grant read-only access and work without a Nimbus account. A link to a folder also exposes its descendants. Password-protected links unlock for one hour in that browser. Revoking or expiring a link prevents future requests; downloaded copies remain with the recipient. Links also stop working when their creator loses sharing permission or is disabled.

Public links, direct grants, and stars follow an item, and its descendants, when it is renamed or moved through Nimbus or WebDAV. Inherited access does not: after a move, the item loses the permissions it inherited from its old parent folders and gains those of its destination. Moving a folder therefore requires Admin permission on it. Records left at a destination by content removed outside Nimbus are discarded, so they never attach to arriving content.

Moving an item to trash suspends its public links, direct grants, and stars. They do not apply to anything created at the old path in the meantime. Restoring the item returns them unchanged, except for those belonging to accounts or groups removed in the meantime. Permanently deleting the item, including automatic deletion after 30 days, discards them. Changes made outside Nimbus, such as renaming a folder on the host, are not tracked; links and grants stay with the old path.

## Trash and retention

Deleted items remain in **Trash** for 30 days. Users see their own deleted items; server administrators can manage all trash. Restoring requires write access at the original location, an existing parent folder, and an unused filename. Permanent deletion cannot be undone.

Cleanup runs at startup and hourly. It permanently removes expired trash, upload staging files inactive for more than 24 hours, and thumbnails older than 30 days. Browser uploads finalize with a hardlink when supported: the visible file and its temporary staging name share the same data, allowing completion retries without a second full copy. Removing the staging link preserves the visible file. Across filesystem boundaries or where hardlinks are unavailable, Nimbus falls back to a copy and needs additional storage headroom until staging expires. Trash is a recovery convenience, not a backup.

## WebDAV

In **Settings → WebDAV**, select **Create password** and name the device. Copy the generated password before selecting **I’ve saved it**; it is shown only once. Copy the server address and username from the Connection section, then configure the client with:

- URL: `https://your-nimbus-server/dav/`
- Username: your Nimbus account email
- Password: the generated app password

Your normal file permissions apply. Revoking the app password immediately blocks subsequent requests from that client. Use HTTPS for remote access because WebDAV sends credentials using HTTP Basic authentication.

Supported operations are `OPTIONS`, `GET`, `HEAD`, `PROPFIND`, `PUT`, `MKCOL`, `DELETE`, `MOVE`, `COPY`, `LOCK`, and `UNLOCK`. `PROPFIND` supports depth `0` and `1`. Deletes go to trash. File downloads support single byte ranges.

WebDAV is intended for basic file access, not a complete distributed collaboration protocol. `MOVE` and `COPY` refuse to overwrite existing destinations. Locks are exclusive, last one hour, and are cleared on restart. Persistent custom properties (`PROPPATCH`), infinite-depth listings, and shared locks are unsupported. Test the operations your chosen client needs before relying on its editing or synchronization workflow.

## Backups and upgrades

Stop Nimbus before taking a filesystem backup, then copy the entire data root, including `.nimbus`, the config root, and the environment configuration. If `DATABASE_URL` points elsewhere, back up that SQLite database and any journal files too. Restore those together while Nimbus is stopped. Do not delete either Compose volume when stopping the service.

### Storage migration

Local installations keep their existing `.nimbus` state location unless `NIMBUS_CONFIG_ROOT` is set. Docker now defaults to `/config`. If the old default database exists and the new location is empty, startup stops with migration instructions instead of creating new accounts.

To move an existing default database into the new Compose config volume, back up first, then run:

```bash
docker compose stop nimbus
docker compose build nimbus
docker compose run --rm --no-deps --entrypoint sh nimbus -c '
  test -f /data/.nimbus/db.sqlite || exit 1
  test ! -e /config/db.sqlite || exit 1
  for file in /data/.nimbus/db.sqlite /data/.nimbus/db.sqlite-wal /data/.nimbus/db.sqlite-shm /data/.nimbus/db.sqlite-journal; do
    if [ -f "$file" ]; then cp -p "$file" /config/ || exit 1; fi
  done
'
docker compose up -d
```

For Unraid bind mounts or a local installation, stop Nimbus and copy the same database and any companion journal files from the old `.nimbus` directory to the new config directory. Keep `BETTER_AUTH_SECRET` unchanged. Startup gives the config directory to `PUID`:`PGID`. Thumbnails can regenerate, or you can copy `.nimbus/cache` into the config directory too. Leave `.nimbus/trash` and `.nimbus/uploads` under the data root.

Verify your existing accounts, shares, and trash after restarting. The old database copy is a backup of the migration point; it does not receive subsequent changes. Once verified and backed up, you can remove the old database, its journal files, and the old thumbnail cache. An explicit `DATABASE_URL` continues to take precedence and is never relocated automatically.

### Application upgrades

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

Unit tests cover path confinement, permissions, file operations, migrations, retention, and caches. Playwright tests use isolated temporary storage and accounts on port 3100 with desktop and mobile Chromium projects. Local tests use development mode; with `CI=true`, tests use the production build, so run `bun run build` first. Do not run a production build while the development test server is running. CI runs these checks and retains failed browser-test artifacts.

See [the web app README](apps/web/README.md) for the code layout and database development commands.
