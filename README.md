<p align="center">
  <img src="docs/assets/nimbus-icon.svg" alt="Nimbus logo" width="120" height="120" />
</p>

<h1 align="center">Nimbus</h1>

<p align="center">A self-hosted file manager with account and group sharing, public download links, and WebDAV access.</p>

Files stay on your filesystem. Accounts, permissions, links, and preferences are stored in SQLite.

## Features

- Browse folders in list or grid views with sorting, breadcrumbs, and live updates.
- Open two folders side by side in split view to drag, move, or copy items between them. Hold Ctrl (Option on macOS) while dragging to copy. Press `|` in a listing to open or close it and `\` to switch panes.
- Upload files with resumable transfers, create folders, rename, move, download, and restore deleted items.
- Keep earlier versions of replaced files, and download or restore them.
- Install Nimbus as an app from supporting browsers.
- Preview images, PDF, audio, video, rendered Markdown, CSV and TSV tables, and syntax-highlighted code. Step through a folder with the arrow keys or by swiping. Edit text files in the browser. Download folders as ZIP archives.
- Thumbnails for images, PDFs, and videos in grid view and on public links.
- Search filenames as you type and keep starred and recently opened items.
- Share files and folders with existing users or groups using read, write, or sharing-management permissions.
- Create read-only public links with optional passwords, expiration, download limits, and a preview-only mode. Edit or revoke them later.
- Request files: share an upload link so people without an account can add files to a folder without seeing its contents.
- Manage users, groups, account roles, disabled accounts, and password resets from Settings → Administration.
- Connect WebDAV clients with individually revocable app passwords.
- Connect AI assistants over MCP, approved in the browser and revocable per client.
- Choose built-in light and dark themes, import VS Code themes, or find community themes on Open VSX.

## Local setup

Use Bun 1.4.4, the version the repository pins. Upgrading Bun is a deliberate change made in three places: `packageManager` in the root `package.json`, `bun-version` in `.github/workflows`, and the `oven/bun` tag and digest in the `Dockerfile`. Run these commands from the repository root:

```bash
bun install --frozen-lockfile
bun run setup
bun dev
```

Open [http://localhost:3000/signup](http://localhost:3000/signup) and create the first account. It becomes the server administrator. Public registration closes after that account is created. Add other accounts from **Settings → Administration → Users & groups**. Each account gets its own home folder; share other folders with them as needed.

`bun run setup` generates `apps/web/.env` with a random auth secret and creates a local data directory. It preserves an existing `.env`. Database migrations run before the server accepts requests.

## Docker deployment

The included Compose configuration builds Nimbus locally and persists files in `nimbus-data` and application state in `nimbus-config`. Docker Engine with Compose is required.

From the repository root, create a `.env` file for Compose containing:

```dotenv
BETTER_AUTH_SECRET=REPLACE_WITH_RANDOM_SECRET
BETTER_AUTH_URL=http://localhost:3000
```

Generate the secret with `openssl rand -base64 32` and paste its output as the value. Keep this file private and keep the same secret across restarts. Compose passes the auth settings, `PUID`, `PGID`, and `UMASK` to the container. To use other settings from [Configuration](#configuration), such as SMTP, single sign-on, or `NIMBUS_TRUSTED_PROXIES`, add them under `environment` in `compose.yaml`.

```bash
docker compose up -d --build
docker compose logs -f nimbus
```

Open [http://localhost:3000/signup](http://localhost:3000/signup) to create the administrator. Compose binds port 3000 to the host's loopback interface. For remote access, put an HTTPS reverse proxy in front of it and set `BETTER_AUTH_URL` to the public origin, for example `https://files.example.com`. The proxy must preserve the request host and forwarded protocol, allow WebDAV methods, and permit your intended upload sizes and transfer durations. Disable buffering for the live event stream. Serve Nimbus at the origin root, not under a URL prefix.

### HTTPS reverse proxy

Nimbus speaks plain HTTP/1.1 and expects a reverse proxy in front of it to provide HTTPS, which browsers require for passkeys. Speak HTTP/1.1 to Nimbus; HTTP/2 or HTTP/3 towards browsers is fine but not needed for speed, since the file browser's first visit loads about 30 scripts and fits in the six connections browsers open over HTTP/1.1. Nimbus already compresses its files, so leave compression off in the proxy, and do not buffer uploads or the live event stream.

[Caddy](https://caddyserver.com) does all of this by default:

```caddyfile
files.example.com {
	reverse_proxy 127.0.0.1:3000 {
		transport http {
			versions 1.1
		}
	}
}
```

nginx needs the buffering and size limits lifted:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name files.example.com;
    ssl_certificate /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    client_max_body_size 0;
    client_body_timeout 1h;
    gzip off;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Set `NIMBUS_TRUSTED_PROXIES` to the proxy's address so rate limits and the audit log see each visitor's address; see [Reverse proxies and client addresses](#reverse-proxies-and-client-addresses).

The server runs as an unprivileged user, by default UID and GID 1000. Set `PUID` and `PGID` to the numeric owner of your host directories, and Nimbus creates files as that user. `UMASK` (default `022`) sets the permissions of new files; `002` makes them group-writable. The container starts as root only to apply these settings, then drops privileges before the server starts. At startup it takes ownership only of what Nimbus writes itself: the `/data` directory itself, the config root with its database, journal files, backups, and thumbnail cache, the reserved `/data/.nimbus` folder with its own subfolders, and unfinished uploads. It never changes the ownership of your files, including trashed items, saved versions, and any file that shares its data with a user file through a hard link. It first refuses a `NIMBUS_CONFIG_ROOT` that is `/`, contains the data root, or lies inside the data root outside `.nimbus`, and a `NIMBUS_DATA_ROOT` of `/`, so a mistyped path cannot change ownership of anything. If you start the container with `--user` instead, these variables are ignored and the mounts must already be writable by that user. Persist both `/data` (managed files, trash, upload staging) and `/config` (database and thumbnail cache). Use one Nimbus process per data root, on a local filesystem. Locks, live events, and mutation coordination are maintained within that process.

### Published image

The CI workflow builds the Dockerfile for `linux/amd64` and `linux/arm64` on native runners while the checks run, and gives the image the tags below only after every check passes for the same commit; pull requests build without publishing. Pushes to `main` and version tags such as `v1.2.3` that pass publish a multi-platform image to GitHub Container Registry with signed build provenance. Each Bun stage uses the `oven/bun:1.4.4` base image pinned by its multi-platform digest.

- `ghcr.io/augusdogus/nimbus:1.2.3` is published from the `v1.2.3` tag.
- `ghcr.io/augusdogus/nimbus:latest` tracks the most recently published stable release.
- `ghcr.io/augusdogus/nimbus:edge` tracks builds from `main` for testing unreleased changes.
- Prerelease tags such as `v1.3.0-beta.1` publish `:1.3.0-beta.1` without updating `:latest`.
- `ghcr.io/augusdogus/nimbus:unverified` is the most recent build, whether or not its checks passed. Do not deploy it.

To use a published image, replace `build: .` in `compose.yaml` with `image: ghcr.io/augusdogus/nimbus:latest`, keeping the environment and both volume mappings. Then run:

```bash
docker compose pull
docker compose up -d --no-build
```

Publishing uses the workflow's `GITHUB_TOKEN`; no registry secret needs to be configured. After the first publish, the package owner should set its visibility to **Public** in GitHub's package settings to allow pulls without signing in. New GHCR packages default to private. See [GitHub's registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

### Unraid

Set `PUID=99` and `PGID=100`, Unraid's `nobody:users` owner for shares, so files created by Nimbus are accessible over SMB and to other containers.

In the container's **Advanced View**, add `--sysctl net.ipv4.tcp_migrate_req=1 --stop-timeout 35` to **Extra Parameters**, so [restarts without downtime](#restarts-without-downtime) hand every connection to the new server and a container stop lets responses finish.

An existing installation that ran with another `PUID`, including every installation from images before `PUID` existed (which ran as `1000:1000`), owns its folders as that user. Nimbus never re-owns your files, so after changing `PUID` it cannot write to those folders, including existing home folders, until you re-own them. Either keep the old `PUID` and `PGID`, or stop Nimbus and re-own the data once, for example from the Unraid terminal with `chown -R 99:100 /mnt/user/data`, or with Compose:

```bash
docker compose stop nimbus
docker compose run --rm --no-deps --entrypoint chown nimbus -R 99:100 /data
docker compose up -d
```

Use these container path mappings:

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

Set the deployment values in `apps/web/.env` before startup. For PDF and video thumbnails, and PDF previews in browsers without a PDF viewer, install Poppler (`pdftoppm`, `pdfinfo`) and `ffmpeg` (for example `apt install poppler-utils ffmpeg`); without them those files show generic icons, and those browsers are offered opening or downloading a PDF instead. The Docker image includes both. `bun run build` builds the browser app into `apps/web/dist`; `bun run start` runs one Bun process that applies migrations, serves that app, the API, and WebDAV, and schedules retention cleanup. The process listens on all interfaces; put your service manager and HTTPS proxy in front of it as appropriate.

## Configuration

| Variable                      | Purpose                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`          | Required random secret of at least 32 characters. Protect it and keep it across restarts.                                           |
| `BETTER_AUTH_URL`             | Public origin, including scheme and port when needed. Set it whenever other people reach Nimbus. Unset, Nimbus uses `http://localhost:<PORT>` for WebDAV, MCP, and its security headers, while Better Auth takes the origin for sign-in callbacks from each request's `Host` header, which a client controls. Required when SMTP is set, so password reset links never come from that header. |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Optional comma-separated additional trusted origins. Compose defaults this to `BETTER_AUTH_URL`.                                    |
| `NIMBUS_DATA_ROOT`            | Filesystem directory to manage. Local default: `apps/web/data` when launched with the supplied scripts. Container default: `/data`. |
| `NIMBUS_CONFIG_ROOT`          | Database and thumbnail cache directory. Local default: `<data root>/.nimbus`. Container default: `/config`. |
| `NIMBUS_HOMES_PATH`           | Folder inside the data root that holds every account's home folder, relative to the data root, for example `users` or `team/users`. Default `users`. See [Home folders](#home-folders). |
| `DATABASE_URL`                | Optional SQLite URL, overriding the config root for the database only. Default: `file:<config root>/db.sqlite`. Use an absolute path when overriding it. |
| `PORT`                        | Listening port, default `3000`. Update the public origin and proxy when changing it. The container health check follows it. |
| `PUID`, `PGID`                | Container only. Numeric user and group the server runs as, default `1000`. |
| `UMASK`                       | Container only. Permission mask for new files and folders, default `022`. |
| `NIMBUS_TRUSTED_PROXIES`      | Comma-separated addresses or CIDR ranges of your reverse proxies, for example `127.0.0.1, 172.16.0.0/12`. Unset means `X-Forwarded-For` is ignored. See [Reverse proxies and client addresses](#reverse-proxies-and-client-addresses). |
| `NIMBUS_AUDIT_RETENTION_DAYS` | Days to keep audit log entries, from 30 to 36500. Default `365`. |
| `NIMBUS_SMTP_HOST`            | SMTP server for password reset email. Email is off unless this and `NIMBUS_SMTP_FROM` are set. |
| `NIMBUS_SMTP_FROM`            | Sender address, for example `Nimbus <nimbus@example.com>`. |
| `NIMBUS_SMTP_SECURITY`        | `starttls` (default, required upgrade), `tls` (implicit TLS), or `plain` (unencrypted, local relays only). |
| `NIMBUS_SMTP_PORT`            | Default `465` for `tls`, otherwise `587`. |
| `NIMBUS_SMTP_USER`, `NIMBUS_SMTP_PASSWORD` | SMTP credentials. Set both, or neither for an unauthenticated relay. |
| `NIMBUS_OIDC_ISSUER`          | OpenID Connect issuer URL. Single sign-on is off unless this, `NIMBUS_OIDC_CLIENT_ID`, and `NIMBUS_OIDC_CLIENT_SECRET` are set. Nimbus reads `<issuer>/.well-known/openid-configuration`. |
| `NIMBUS_OIDC_CLIENT_ID`, `NIMBUS_OIDC_CLIENT_SECRET` | Client credentials registered with the provider. Register `<BETTER_AUTH_URL>/api/auth/callback/oidc` as the redirect URI. |
| `NIMBUS_OIDC_NAME`            | Provider name on the sign-in button, for example `Authentik`. Default `single sign-on`. |
| `NIMBUS_OIDC_AUTO_PROVISION`  | `true` lets provider identities without a Nimbus account create a member account. Default `false`. |
| `NIMBUS_OIDC_GROUPS_CLAIM`    | Optional ID token claim listing group names, for example `groups`. See [Single sign-on](#single-sign-on). |
| `NIMBUS_BACKUP_KEEP`          | Daily database backups to keep in `<config root>/backups`, default `7`. |
| `NIMBUS_WATCH_DEBOUNCE_MS`    | Milliseconds to wait for changes made outside Nimbus to settle before open folders and search refresh, default `300`. Invalid values use the default. |
| `NIMBUS_RECONCILE_INTERVAL_MS` | Milliseconds between comparisons of the search index with the disk, which catch changes the file watcher missed and check again folders it could not read, default `1800000` (30 minutes), from `1000` to `2147483647` (about 24 days). Other values use the default. |
| `NIMBUS_MCP_ENABLED`          | Optional. `false` turns off the MCP server, its OAuth endpoints, and discovery documents. Default: `true`. Approved clients stay stored. |
| `NIMBUS_DRAIN_HOURS`          | Container only. Hours a server replaced by a [restart without downtime](#restarts-without-downtime) keeps sending the responses it had started, such as a film, from `0.01` to `48`. Default `6`. |
| `NIMBUS_MAX_DRAINING`         | Container only. Replaced servers kept finishing their responses at once, from `1` to `8`. One more makes the oldest stop now. Default `2`. |
| `NIMBUS_READY_TIMEOUT_SECONDS` | Container only. Seconds a new server may take to migrate, index the drive and pass its health check before a restart is abandoned and the running server keeps serving. Default `300`. |
| `NIMBUS_STOP_SECONDS`         | Container only. Seconds every server may finish its responses when the container stops. Keep it below the container's stop timeout. Default `30`. |

Startup fails with a message naming the problem when an optional integration is only partly configured or a setting has an invalid value, such as `NIMBUS_MCP_ENABLED=no` or an unsafe `NIMBUS_HOMES_PATH`, so a typo cannot silently turn email, single sign-on, or MCP off.

The reserved `<data root>/.nimbus` directory contains trash and temporary uploads. Without a separate config root, it also contains the database and thumbnail cache. Nimbus never exposes `.nimbus` through file browsing or sharing. Keep a separate config root outside the browsable data root. Symbolic links and special files are excluded. Startup makes the config root owner-only (`700`) and the database and its journal files `600`, and stops with the fix when it cannot, for example because a restored file belongs to another user. Nimbus needs read and write access to both roots; other local programs with access to those directories remain outside Nimbus's permission controls.

Nimbus follows changes made outside it with one inotify watch per folder of the data root. A folder it cannot read, such as another container's private folder, is skipped and logged once: its contents stay out of search and live updates, and it is checked again at each reconciliation (`NIMBUS_RECONCILE_INTERVAL_MS`) and included once readable. If the host's `fs.inotify.max_user_watches` is lower than the number of folders, Nimbus logs that once, releases its watches and keeps serving, and finds outside changes only at each reconciliation; raise the limit on the host and restart Nimbus. The limit is shared by every program running as the same user.

## Settings

Open the settings cog beside **Trash** to switch to the settings sidebar:

- **Appearance:** choose System, Light, or Dark mode and a separate theme for each color scheme. **Add theme** supports VS Code theme files and Open VSX community search. Themes and selections are saved in this browser. See [theme details and import limits](apps/web/README.md#themes).
- **Account:** view your name and email, change your password, set up two-factor authentication and passkeys, and review or sign out your browser sessions. Changing your password signs out other browser sessions; WebDAV app passwords remain active.
- **WebDAV:** copy your server address and username, create a password for each device, and revoke passwords you no longer need.
- **MCP:** copy the MCP server address and setup command, see connected AI clients with when they were last used, and disconnect them.
- **Administration → Users & groups** (server administrators only): create accounts, manage group membership, grant drive access, and back up the database. Each user's action menu contains sign in as user, password reset, sign-in method reset, sign out everywhere, administrator role, and enable/disable controls.
- **Administration → Audit log** (server administrators only): review sign-ins and failures, account and role changes, group and permission changes, public links and file requests, version restores, deletions and emptied trash, database backups, app passwords, and connected AI clients. Filter by event, account, and date.

Use **Back to files** to return to the drive. Active uploads continue while you browse Settings.

## Signing in and account security

Password sign-in can be followed by a second factor. In **Settings → Account → Two-factor authentication**, select **Set up**, scan the QR code with an authenticator app, and enter its code. Each authenticator code works once: a code already used to sign in or to set up the app is refused, so enter the next one. Save the ten recovery codes shown once; each signs you in one time if you lose the authenticator. **New recovery codes** replaces them. When signing in, **Trust this browser for 30 days** skips the code on that browser.

Passkeys sign in with your device's fingerprint, face, or PIN and count as both factors, so they skip the code. Add them under **Passkeys**, then use **Sign in with a passkey** or pick one from the email field's autofill. Nimbus requires user verification. Passkeys are bound to the host name in `BETTER_AUTH_URL`; changing it makes existing passkeys stop working.

If someone loses every factor, an administrator selects **Reset sign-in methods** in that account's action menu. It removes two-factor authentication, recovery codes, passkeys, trusted browsers, and WebDAV app passwords, signs the account out everywhere, and disconnects its MCP clients, so connected WebDAV devices and AI clients are disconnected too. The person then signs in with their password, sets up their sign-in methods again, and creates new app passwords for their devices.

To see what a member sees or fix something for them, an administrator selects **Sign in as user** in that account's action menu. The session lasts at most one hour, and a banner on every page names the account and offers **Stop impersonating**, which returns to **Users & groups**. The audit log records the start and the end, and marks everything done meanwhile with the administrator's name. Administrators cannot sign in as other administrators, and while signed in as someone they cannot change that person's password, email, sign-in methods or sessions, create app passwords, or connect AI clients. Disabling the account or resetting its sign-in methods ends the session.

**Sessions** lists browsers signed in to your account with their last activity and address. Sign out any one, or every other session at once; signing out other browsers leaves MCP clients connected.

Changing your password, resetting it by email, an administrator setting a new one, and **Sign out everywhere** in **Users & groups** each disconnect every MCP client of the account, which must then be authorized again. WebDAV app passwords keep working through these; see below.

### WebDAV app passwords and two-factor authentication

WebDAV clients cannot show a code prompt, so app passwords bypass two-factor authentication by design. They are random 256-bit tokens, created only from a signed-in browser session (which already passed two-factor authentication), shown once, stored as hashes, scoped to file access with your permissions, and individually revocable. They cannot sign in to the web interface or change account settings. Revoke an app password as soon as a device is lost. Changing your password does not revoke app passwords. An administrator resetting your sign-in methods revokes them all, and disabling the account blocks them.

### Password reset

With SMTP configured, the sign-in page offers **Forgot password?**. SMTP requires `BETTER_AUTH_URL`, so reset links always point at the configured address rather than one taken from the request. The emailed link works once, for one hour, and resetting signs out every session and disconnects every MCP client. Requests always report success so they do not reveal which addresses have accounts. Without SMTP, administrators reset passwords from **Users & groups**.

Nimbus does not send email verification messages. Registration is closed, so every address is entered by an administrator, or by the server owner for the first account, and Nimbus treats those addresses as verified. Verification would add a step without protecting against anything a closed server allows.

### Single sign-on

Nimbus can sign people in through one OpenID Connect provider such as Authentik, Keycloak, Authelia, or Microsoft Entra ID. Registration stays closed: a provider identity signs in to the Nimbus account with the same email address, and only when the provider marks that address as verified. Other identities are refused with a message to ask an administrator. Set `NIMBUS_OIDC_AUTO_PROVISION=true` to create member accounts for them instead; new accounts start with only their own home folder. The administrator account must exist before single sign-on can provision accounts. Two-factor authentication applies to password sign-in; enforce multi-factor sign-in for single sign-on at your provider.

With `NIMBUS_OIDC_GROUPS_CLAIM` set, every single sign-on sign-in makes the provider the source of truth for all of that person's Nimbus group memberships. They join the Nimbus groups whose names match the claim exactly and leave every other group, including groups an administrator added them to. Groups are never created automatically. The claim must be in the ID token; request the matching scope from your provider if needed.

### Rate limits

Nimbus limits sign-in, sign-up, password reset, second-factor, and passkey attempts per client address, wrong public link and file request passwords, file request uploads, WebDAV authentication failures, and MCP registration, token, and tool requests. Password sign-in is also limited per account: after 10 attempts at one account from addresses it has not signed in from, further attempts from new addresses wait about 90 seconds each. The account is never locked, addresses where its owner signed in with the password before are exempt, and passkeys and single sign-on are not affected. Limited requests receive `429 Too Many Requests` with a `Retry-After` header. Limits are kept in memory and reset when Nimbus restarts.

### Reverse proxies and client addresses

Rate limits, sessions, and the audit log use the client address. By default Nimbus uses the address of the connecting socket and ignores `X-Forwarded-For`, because any client can send that header. Behind a reverse proxy every request would then appear to come from the proxy. Set `NIMBUS_TRUSTED_PROXIES` to the proxy addresses, for example `127.0.0.1` for a proxy on the same host or the Docker network range for a proxy container. Nimbus then reads `X-Forwarded-For` from right to left, skipping trusted proxies, and uses the first untrusted address. List only addresses you control, and make sure clients cannot reach Nimbus without passing through the proxy.

### Security headers

Every page is served with a Content-Security-Policy that allows only scripts carrying a fresh per-request nonce (`'strict-dynamic'`), so injected scripts do not run. The server writes the nonce into the page's own script tags; the page is never cached. It also forbids plugins, `<base>` tags, cross-origin form targets, and embedding Nimbus in other sites (`frame-ancestors 'none'`). Inline styles stay allowed because the interface components set them at runtime. File previews keep their own sandbox policy. Responses also send `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a `Permissions-Policy` that turns off camera, microphone, location, payment and USB access, and `Cross-Origin-Opener-Policy: same-origin`.

When `BETTER_AUTH_URL` uses `https`, Nimbus adds `Strict-Transport-Security: max-age=31536000`, marks session, public link, and file request cookies `Secure`, and adds `upgrade-insecure-requests`. Configure your proxy to redirect plain HTTP to HTTPS. Session cookies are always `HttpOnly` and `SameSite=Lax`.

## Sharing and permissions

Server administrators have access to the entire drive. Every account also gets a private home folder. **Files** in the sidebar opens the drive root for administrators and for anyone something outside their home has been shared with, showing only the folders they can reach; for everyone else it opens their home folder, which is then the root of the breadcrumb. After signing in without a link to follow, administrators start at the drive root and everyone else in their home folder; `/home` always opens it. Administrators can share any other folder; recipients find them under **Shared → Shared with me**, which leaves out their own home. Sharing the drive root or the folder that holds the home folders is off by default, see [Sharing the home folders container](#sharing-the-home-folders-container).

### Home folders

Homes live in one folder inside the data root, `users` unless `NIMBUS_HOMES_PATH` names another, with one folder per account. The folder name comes from the part of the email address before `@`, lowercased, for example `users/jane.doe` for `Jane.Doe@example.com`. It is fixed when the account is created: changing the email later does not rename or reassign it. If that name is already taken by any folder, a number is added (`users/jane.doe-2`); Nimbus never takes over an existing folder.

- **The `users` folder:** Nimbus creates it at startup and records that in the database. It never puts homes into a folder it did not create, because sharing already on that folder would expose every home. Startup stops with a message naming what it found when the folder already exists (compared case-insensitively, even when empty), or when grants or public links on it, inside it, or on a folder above it (including the drive root), or upload links or bookmarks on it or inside it, already exist. Database migrations still apply, but no folders or sharing change. To continue, set `NIMBUS_HOMES_PATH` to a folder that does not exist yet and is not inside a shared folder, or rename the existing folder and remove its sharing. Later, while a grant or public link covers the folder (on it or on a folder above it), new accounts get no home and startup logs why; sharing inside existing homes does not count. These paths are compared without regard to case or Unicode spelling, such as a decomposed `é`, so every name a case-insensitive or normalizing volume treats as the same folder counts. A new home never takes the path of a home or a folder that held homes before, even when its folder is gone.
- **Changing `NIMBUS_HOMES_PATH`:** existing homes stay where they are, with their files and grants; Nimbus never moves user data. Only accounts without a home get one in the new folder. The old folder stays protected while it is Nimbus's, and setting the variable back reuses it.
- **Creation:** with the account. Existing accounts without a home get one at the next startup. If the folder cannot be created, for example because the data root is read-only, the account still works and startup logs the reason and retries next time.
- **Access:** the owner gets Admin permission on their home, so they can upload, organize, share, and create public links there. Other users see only homes shared with them. Server administrators see every home.
- **Protection:** a home folder, the folder that holds them, and any folder containing either cannot be renamed, moved, or deleted. Their contents can.
- **Account removal:** the home folder and its files stay in place, visible to server administrators, and the account's grants are removed. The folder is then an ordinary folder that administrators can move or delete. A new account never reuses it.

#### Sharing the home folders container

A grant or public link reaches everything inside its folder, so one on the `users` folder, or on a folder above it such as the drive root (**Files**), would open every account's home. An upload link there opens no home, but would let anyone with it add files beside them. By default nobody can create any of the three there, administrators included: the share dialog explains why and keeps the button disabled, and the API, MCP tools and every other way of sharing refuse with a message saying that nothing changed and to share individual folders instead. Sharing a single home folder, or anything inside one, works as usual. Moving or restoring an item into the place of a home folder, the `users` folder or a folder above it is refused too, so a shared folder cannot take that place if it goes missing outside Nimbus.

A server administrator can turn on **Allow sharing the home folders container** in **Settings → Administration → Users & groups**, after a confirmation. The change is recorded in the audit log, and only an administrator signed in to their own account in the browser can make it: not while signed in as someone else, and not through app passwords or MCP clients. While it is on, each new grant, public link or upload link that would reach every home folder shows how many home folders it exposes and needs an extra confirmation; MCP tools refuse it unless the call passes `acknowledgeAllHomeFolders: true`. While any grant or public link covers the `users` folder, new accounts get no home folder, as described above. An upload link there does not stop them: it only adds files beside the home folders and never opens one.

Turning the setting off never deletes sharing, and it waits for any share already being created, so the list below is complete once it returns. Grants and links created while it was on keep working and are listed under **Home folders** in the same settings page, with a button to remove each one or all of them; new ones are refused again, and new accounts get no home folder until the remaining grants and links are removed.

| Permission | Access                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Read       | Browse, preview, and download the item and its contents.                                                                                |
| Write      | Read access plus uploads, folder creation, file changes, and moving items to trash.                                                     |
| Admin      | Write access plus managing permissions, public links, and file requests for that subtree. Moving a folder requires this level on it. Copying a file or folder requires Read on it and Write on the destination, in the browser, over WebDAV, and over MCP. |

Permissions apply to descendants and are additive. User and group grants combine using the strongest matching permission. A narrower grant cannot reduce access inherited from a parent. Remove the parent or group grant to remove that inherited access. A folder administrator is distinct from a server administrator.

Manage links you created under **Shared → Public links** and **Shared → File requests**.

Public links grant read-only access and work without a Nimbus account. A link to a folder also exposes its descendants. Password-protected links unlock for one hour in that browser. Revoking or expiring a link prevents future requests; downloaded copies remain with the recipient. Links also stop working when their creator loses sharing permission or is disabled.

Public links, file requests, direct grants, and stars follow an item, and its descendants, when it is renamed or moved through Nimbus, WebDAV, or MCP. Inherited access does not: after a move, the item loses the permissions it inherited from its old parent folders and gains those of its destination. Moving a folder therefore requires Admin permission on it. Records left at a destination by content removed outside Nimbus are discarded, so they never attach to arriving content.

Moving an item to trash suspends its public links, file requests, direct grants, and stars. If Nimbus stops partway through moving an item to trash, restoring it, or moving it, for example in a power cut, the next start finishes or undoes that change, so the item keeps its own sharing and history. If another program replaced the item while Nimbus was stopped, the start leaves its sharing as it was and logs a warning to check it. They do not apply to anything created at the old path in the meantime. Restoring the item returns them unchanged, except for those belonging to accounts or groups removed in the meantime. Whoever deleted an item can restore it with the access they had when deleting it, including a grant on the item itself.

On case-insensitive storage, such as an SMB dataset, ext4 with casefolding or a macOS host, `Report.docx` and `report.docx` name the same file. WebDAV locks and Nimbus's own coordination of changes treat every spelling as one path. Grants, links and file requests match the exact spelling they were created with: another spelling reaches the same item on such storage but never extends access, so open items through Nimbus or with the spelling it shows. When Nimbus creates an item, sharing records, stars and WebDAV properties left under another spelling of its path by content removed outside Nimbus are discarded too; version history left under another spelling stays with that spelling. Permanently deleting the item, including automatic deletion after 30 days, discards them. Changes made outside Nimbus, such as renaming a folder on the host, are not tracked; links, grants, and version history stay with the old path. They never attach to new content: whenever Nimbus creates an item at a path where nothing exists (a new folder, upload, copy, WebDAV or MCP write, or home folder), it first discards any records left there by content removed outside Nimbus.

Select **Edit** on a public link to change its password, expiry, download limit, or mode without changing its address. A new or removed password ends earlier unlocks. A download limit counts each transfer of a file or ZIP, including opening a preview; resumed downloads and video seeking do not count again. Once the limit is used, the link stops working until you raise it. **Preview only** removes download and ZIP actions and refuses files the browser cannot preview. It is not copy protection: anything a browser displays can still be saved.

To request files, open a folder's **Share** action and select **Request files**. Anyone with the upload link can add files to that folder. They cannot list, open, replace, or delete anything, including their own uploads. A file with a taken name gets a number added. Optional settings are a password, an expiry, a note shown to uploaders, a largest file size, a number of files, and a total size. Uploads are resumable; unfinished uploads count toward the limits for up to a day, then their space is released. Each link accepts at most 20 uploads at a time, and uploads are refused when less than 1 GB, or 5% of the disk if that is more, would remain free. Upload links stop working under the same conditions as public links. Files uploaded through a link belong to the folder like any other file.

## Previews, editing, and search

PDFs open in the browser's own viewer where it can show one in the page. Browsers without one, such as Chrome on Android, see images of the pages instead: the server renders each one with Poppler as it scrolls into view, so a long document never loads at once. They show the first 1,000 pages; **Open in a new tab** shows the whole file. On a public link, opening the PDF this way counts as one transfer for its download limit, and the count is given back if the pages are not delivered: the PDF cannot be drawn, it changed meanwhile, the server is busy, or the visitor leaves first. For the next hour that browser's further pages, and opening or downloading that version of the PDF, do not count again; another browser, another file, or a changed file counts. A file counts as changed when its content, size, modification time or change time differs, so a permission change also ends that hour early.

Text, Markdown, and code previews load the first 1 MB of a file. Markdown is rendered without raw HTML or images, and only web, email, and in-page links are kept, so a file cannot run scripts or contact other servers. Previews are served with a sandboxing Content Security Policy.

Users with write permission can edit text files of up to 1 MB from the preview, and save them at up to 5 MB, so edits can make a file larger. Saving checks that the file has not changed since it was opened; if it has, the save is refused, the file on disk is kept, and your edits stay in the editor, where you can overwrite the file with them or discard them to see the current text. Saves also respect WebDAV locks held by other clients, and the previous content is kept as a [version](#versions).

Search matches file and folder names anywhere in the drive that you can read. Nimbus indexes names in memory at startup, keeps the index current from filesystem changes, and re-checks the whole drive every 30 minutes to catch changes made while it was stopped. Until the first index completes, the search page says results may be incomplete. One-letter searches match the beginning of names.

## Trash and retention

Deleted items remain in **Trash** for 30 days. Users see their own deleted items; server administrators can manage all trash. Restoring requires write access at the original location, an existing parent folder, and an unused filename. Permanent deletion cannot be undone.

Cleanup runs at startup and hourly. It permanently removes expired trash, versions older than 30 days, upload staging files and file request reservations inactive for more than 24 hours, thumbnails older than 30 days, and audit log entries past their retention. It also takes the daily [database backup](#database-backups) when one is due. Browser uploads finalize with a hardlink when supported: the visible file and its temporary staging name share the same data, allowing completion retries without a second full copy. Removing the staging link preserves the visible file. Across filesystem boundaries or where hardlinks are unavailable, Nimbus falls back to a copy and needs additional storage headroom until staging expires. Trash is a recovery convenience, not a backup.

## Versions

When a file is replaced, Nimbus keeps its previous content as a version. Open a file's actions and select **Version history** to download a version or, with write access, restore it. Restoring keeps the current content as another version, so it can be undone. History belongs to the file's path, like its links and grants: it follows the file through renames, moves, and trash made through Nimbus, WebDAV, or MCP, and is removed when the file is permanently deleted. A program on the host that saves by writing a new file over the old one keeps the history; renaming a file on the host leaves its history at the old path, and a new file Nimbus creates there starts with none. Because history does not depend on inode numbers, it survives reboots and Unraid's Mover. Each file keeps its 25 most recent versions for up to 30 days; hourly cleanup removes older ones. Versions share disk space with the file through reflinks on filesystems that support them (Btrfs, XFS, ZFS 2.2 and later). Elsewhere a file not written in the last minute becomes its version through a hard link, and a recently written one is copied, because a program that still has it open could otherwise change the saved version. A program that keeps a file open but idle for longer than a minute and then writes to it can still change a version on such filesystems.

Versions are stored in `<data root>/.nimbus/versions`. Keeping a version adds a hardlink to the previous content rather than copying it. Where hardlinks are unavailable, Nimbus uses a reflink on filesystems that support them (Btrfs, XFS, recent ZFS), and otherwise a full copy. Each version still holds its content on disk until it expires. Every way Nimbus replaces a file's content creates a version: uploading with **Replace**, saving in the editor, WebDAV `PUT`, MCP `write_text` and upload links, and moving or copying a file over another. Edits that other programs make directly on the host do not.

## Installing the app

Browsers that support installable web apps, such as Chrome, Edge, and Safari, can install Nimbus from the address bar or share menu. The installed app's title bar follows the selected theme. Installation requires HTTPS, except on `localhost`. Nimbus does not use a service worker: in measurements it made navigation slower without saving any downloads, so it works online only.

## WebDAV

In **Settings → WebDAV**, select **Create password** and name the device. Copy the generated password before selecting **I’ve saved it**; it is shown only once. Copy the server address and username from the Connection section, then configure the client with:

- URL: `https://your-nimbus-server/dav/`
- Username: your Nimbus account email
- Password: the generated app password

Your normal file permissions apply. Revoking the app password immediately blocks subsequent requests from that client. Use HTTPS for remote access because WebDAV sends credentials using HTTP Basic authentication.

Nimbus implements WebDAV classes 1 and 2 (RFC 4918) and passes the complete [Litmus 0.18](https://notroj.github.io/litmus/) conformance suite, which runs in CI.

- **Methods:** `OPTIONS`, `GET`, `HEAD`, `PROPFIND`, `PROPPATCH`, `PUT`, `MKCOL`, `DELETE`, `MOVE`, `COPY`, `LOCK`, and `UNLOCK`. Deletes go to trash. Downloads support single byte ranges. Uploads may use chunked transfer encoding.
- **Listings:** `PROPFIND` supports depth `0` and `1`, `allprop`, `propname`, and named properties. Infinite depth is refused, as RFC 4918 permits. Properties include size, content type, modification and creation dates, ETag, lock state, and the filesystem's free and used space (RFC 4331).
- **Custom properties:** `PROPPATCH` stores properties set by clients, such as the Windows `Win32*` file attributes, and returns them in later listings. They move, copy, and go to trash with their item. Setting `Win32LastModifiedTime` also sets the file's modification time.
- **Replacing items:** `MOVE` and `COPY` honor the `Overwrite` header, which defaults to `T`. Moving a file over another file replaces its content and keeps the destination's links, grants, and stars, so applications that save through a temporary file keep their sharing. The replaced content is kept as a version. Replacing a folder, or a file with a folder, sends the replaced item to trash.
- **Locks:** exclusive and shared write locks, depth `0` or infinity, on files, folders, and unmapped URLs (which creates an empty file). A lock lasts for the client's requested timeout, up to one hour, and clients can refresh it. Locks also block conflicting changes from the web interface. They are kept in memory and cleared on restart. `If` header conditions with lock tokens and ETags are evaluated.
- **Modification times:** uploads, moves, and copies accept the `X-OC-Mtime` header used by rclone and ownCloud clients.
- Request URLs must percent-encode `#` in names as `%23`; a URL containing `#` is refused so a fragment can never redirect a delete to the parent folder.

Client notes:

- **Windows Explorer** (Map network drive): use an HTTPS address, because Windows only sends Basic credentials over HTTP after a registry change (`BasicAuthLevel`). Windows also limits downloads to 50 MB by default (`FileSizeLimitInBytes` under the WebClient service parameters). Not yet tested against Nimbus directly.
- **macOS Finder** (Go → Connect to Server): mounts read-write because locks are supported. Finder stores metadata in `._` files; Nimbus keeps them as ordinary files. Not yet tested against Nimbus directly.
- **GNOME Files, KDE Dolphin, davfs2:** use `davs://your-nimbus-server/dav/`. GNOME Files was tested: mounting, uploads, renames, replacing files, server-side copies, free space, and deletes work.
- **rclone:** configure the remote with `vendor = rclone`. Nimbus then keeps modification times for uploads, moves, and copies, so `rclone sync` detects edits that do not change a file's size, and `rclone mount` preserves times. With `vendor = other`, rclone compares sizes only. `rclone touch` of an existing file is not supported by either profile. Tested with rclone 1.76: `sync`, `check`, `moveto` and `copyto` over existing files, `about`, `purge`, and `mount --vfs-cache-mode writes` with editors that save by renaming a temporary file over the original.

Your normal file permissions apply to every operation. Folders you cannot browse are omitted from listings. To check conformance locally, build Litmus from its release tarball and run `LITMUS_DIR=/path/to/litmus-0.18 bun scripts/webdav-conformance.ts`.

## MCP

Nimbus is a remote [Model Context Protocol](https://modelcontextprotocol.io) server at `https://your-nimbus-server/api/mcp` (Streamable HTTP). AI clients such as Claude Code, Codex, Cursor, and ChatGPT can browse, read, and change your files with your own permissions.

Add the address as a remote MCP server in your client. For Claude Code:

```bash
claude mcp add --transport http nimbus https://your-nimbus-server/api/mcp
```

The client discovers Nimbus's OAuth server, registers itself, and opens Nimbus in your browser. Sign in if needed, review the permissions, and select **Connect**. You can leave **Change your files** or **Manage sharing** unchecked to connect with view access only. No API key is involved.

| Permission | Tools |
| --- | --- |
| View your files | `list_folder`, `get_item`, `search_files`, `read_text`, `get_download_link`, `list_shared_with_me`, `list_trash`, `list_versions` |
| Change your files | `write_text`, `get_upload_link`, `create_folder`, `rename_item`, `move_item`, `copy_item`, `move_to_trash`, `restore_from_trash`, `restore_version`, `set_starred` |
| Manage sharing | `list_public_links`, `create_public_link`, `revoke_public_link`, `list_permissions`, `grant_permission`, `revoke_permission`. `create_public_link` and `grant_permission` take `acknowledgeAllHomeFolders`, see [Sharing the home folders container](#sharing-the-home-folders-container) |

These permissions only narrow what a client may attempt. Every tool runs the same checks as the browser: your file permissions, WebDAV locks, and path rules apply, and `.nimbus` and symbolic links stay hidden. `read_text` returns UTF-8 text in ranges of up to 256 KiB. `write_text` refuses to replace an existing file unless the client passes its current version tag or asks to overwrite. `get_download_link` returns a link that works for five minutes and only while the connection and your access remain; it serves byte ranges like any download.

`get_upload_link` gets files of any size or type into the drive without passing their bytes through the AI client: it returns a URL that takes the raw bytes in one HTTP `PUT`, for example `curl -T video.mp4 "<url>"`, and answers with the new file's path, size and version tag. With `folder: true` it covers a whole folder: `PUT <url>/<relative path>` for each file, and missing subfolders are created. It follows `write_text`'s rules for existing files and can also keep both by numbering the new name. An upload must start within 15 minutes of asking for the link, but may take as long as it needs; each path uploads once per link. The link stops working when the client is disconnected, the account is disabled, your write permission goes, or Nimbus restarts, and these are checked again before the file is saved. An interrupted or refused upload leaves nothing behind, and uploads keep 1 GiB or 5% of the disk free, whichever is larger.

Disconnect a client in **Settings → MCP**; its tokens stop working immediately. Disabling an account cuts off its clients too, and changing or resetting the password, signing out everywhere, or an administrator resetting sign-in methods disconnects them all. Access tokens last one hour and refresh tokens 30 days, rotating on each use; a reused refresh token disconnects the client. Nimbus stores only hashes of tokens. Registration, token, and MCP requests are rate limited per address and per connection; registration is also limited per network, and at most 1,000 registrations that no one has approved are kept, oldest removed first. Set `NIMBUS_MCP_ENABLED=false` to turn MCP off.

### WebMCP

In browsers that support [WebMCP](https://webmachinelearning.github.io/webmcp/) (`document.modelContext`, currently a Chrome and Edge origin trial or `chrome://flags/#enable-webmcp-testing`), the folder view offers page tools to agents running in the browser: list the open folder, open a folder, search, preview a file, create a folder, and start a rename or move. They act with your signed-in session. Rename and move only open their dialogs, so you confirm each change. Other browsers do not download this code.

## Backups and upgrades

### Database backups

Nimbus backs up its database every day while running, using SQLite's `VACUUM INTO` in a separate process. Requests continue during the backup. Backups are compact, consistent snapshots, stored with owner-only permissions in `<config root>/backups`, like the live database and its journal files, as `nimbus-<UTC time>.sqlite`. The newest `NIMBUS_BACKUP_KEEP` (default 7) are kept. Server administrators can select **Back up now** and download backups from **Settings → Administration**. Failed backups are logged and retried within an hour; earlier backups are unaffected.

These backups contain accounts, permissions, links, file requests, trash records, version records, and preferences. They do not contain files. Back up the data root, including `.nimbus` (trash, versions), with your usual file backup tool, and keep the environment configuration with it.

To restore a database backup:

1. Stop Nimbus: `docker compose stop nimbus`, or stop the local process.
2. Move the current `db.sqlite`, `db.sqlite-wal`, and `db.sqlite-shm` from the config root to a safe place. Never combine an old `-wal` file with a restored database.
3. Copy the chosen backup to the config root as `db.sqlite`, writable by the user running Nimbus.
4. Start Nimbus. It applies any newer migrations at startup.

Records created after the backup are lost. Files on disk are unaffected, but items moved to trash or versions created after the backup lose their records; trash and version cleanup removes their leftover content.

### Full backups

For a complete copy, stop Nimbus, then copy the entire data root, including `.nimbus`, the config root, and the environment configuration. If `DATABASE_URL` points elsewhere, back up that SQLite database and any journal files too. Restore those together while Nimbus is stopped. Do not delete either Compose volume when stopping the service.

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

For Unraid bind mounts or a local installation, stop Nimbus and copy the same database and any companion journal files from the old `.nimbus` directory to the new config directory. Keep `BETTER_AUTH_SECRET` unchanged. Startup gives the database, its journal files, backups, and thumbnail cache in the config directory to `PUID`:`PGID`, and stops with a message naming the files if the database still cannot be written, for example when a local installation's files belong to another user. Thumbnails can regenerate, or you can copy `.nimbus/cache` into the config directory too. Leave `.nimbus/trash` and `.nimbus/uploads` under the data root.

Verify your existing accounts, shares, and trash after restarting. The old database copy is a backup of the migration point; it does not receive subsequent changes. Once verified and backed up, you can remove the old database, its journal files, and the old thumbnail cache. An explicit `DATABASE_URL` continues to take precedence and is never relocated automatically.

### Restarts without downtime

In the container, Nimbus runs under a small supervisor that can replace the server with a fresh one without closing its port:

```bash
docker compose exec nimbus bun server/supervisor/control.ts restart
docker compose exec nimbus bun server/supervisor/control.ts status
```

The new server starts beside the running one, builds its search index, applies pending migrations and passes its health check, and only then takes new connections. If it never gets that far, it is stopped and the running server keeps serving. Once it serves, the old server stops taking connections and finishes what it had started:

- **Not interrupted:** a film or any other download already playing continues to its last byte from the server that started it, for up to `NIMBUS_DRAIN_HOURS`; the next request, such as a seek, goes to the new server. Uploads, page loads and API calls carry on. Media addresses, Undo, WebDAV locks and MCP upload links keep working.
- **Reconnected:** live updates in open pages and MCP event streams end and reconnect to the new server at once.
- **Still cut off:** a device disconnected meanwhile, as before. A request a client sends on an idle connection at the very moment the old server closes it can fail; browsers, reverse proxies and media players notice a closed connection before reusing it, so this is rare.

Set `net.ipv4.tcp_migrate_req=1` for the container, as `compose.yaml` does (`docker run --sysctl net.ipv4.tcp_migrate_req=1`, or on Unraid in **Extra Parameters**). Without it, a connection that arrives in the moment the old server leaves the port can be reset; the log says so once at startup. The control socket lives inside the container, reachable only by root and the user Nimbus runs as; nothing about it listens on the network.

Replacing the container, as pulling a new image does, still interrupts Nimbus: connections are refused until the new container is ready, and responses still running when the container stops are cut after `NIMBUS_STOP_SECONDS`, after which players usually resume from where they stopped. Keep the container's stop timeout above that, as `stop_grace_period: 35s` in `compose.yaml` does (`docker run --stop-timeout 35`). A host reboot interrupts Nimbus the same way.

### Application upgrades

To upgrade, back up first, update the checkout, then rebuild and restart. When migrations are pending, startup also backs up the database into `<config root>/backups` before applying them, and applies them in one transaction that rolls back completely on failure:

```bash
docker compose up -d --build
```

For a local installation, reinstall dependencies with the lockfile, build, and restart. Startup applies committed migrations automatically. To apply them explicitly:

```bash
bun run --cwd apps/web db:migrate
```

Existing installations from the original file manager should retain their `DATABASE_URL` and `NIMBUS_DATA_ROOT`. The original default database was `apps/web/nimbus.db`; set `DATABASE_URL=file:/absolute/path/to/apps/web/nimbus.db` to keep using it. The upgrade preserves existing accounts and promotes the oldest account to administrator. Each account gets a home folder at the next startup; other folders must be shared with them. If the data root already has a `users` folder, startup stops without creating or changing any folders or sharing; set `NIMBUS_HOMES_PATH` to a new folder name or rename yours (see [Home folders](#home-folders)). Do not use `db:push` as an upgrade procedure.

`GET /api/health` reports readiness: it returns `200` when the database accepts writes, the data root itself and its `.nimbus` folder are writable, and the config root accepts writes, and `503` otherwise. It cannot check every folder: a folder inside the data root owned by another user, for example after a `PUID` change, still fails writes with a permission error while readiness passes. The Docker health check uses it on the port set by `PORT`. Results are cached for five seconds, and the response never includes details; the server log names the failing check when the state changes. `GET /api/health/live` reports only that the server responds. Neither is a storage-capacity check. Startup fails when configuration or migrations cannot be applied; inspect the process or Compose logs for the failing operation.

## Development and verification

```bash
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
bun playwright install chromium
bun run test:e2e
```

`bun run format` rewrites files with [oxfmt](https://oxc.rs/docs/guide/usage/formatter), configured in `.oxfmtrc.jsonc`. `bun run lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter) over the whole repository with the rules in `.oxlintrc.jsonc`, including type-aware rules that reject `any` flowing into typed code, non-null assertions, unchecked type assertions, and floating promises; warnings fail it. `bun run typecheck` checks each workspace and the root scripts with the native TypeScript 7 compiler, installed as `typescript7`. To skip the formatting commit in `git blame`, run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once.

Unit tests cover path confinement, permissions, file operations, migrations, retention, and caches. Playwright tests use isolated temporary storage and accounts on port 3100, or `NIMBUS_E2E_PORT` when set, with desktop and mobile Chromium projects. Every browser test fails on Content-Security-Policy violations. Local tests use development mode, with Vite on the test port plus 10000 (or `NIMBUS_E2E_VITE_PORT`); with `CI=true`, tests use the production build, so run `bun run build` first. CI runs these checks, then checks that public pages load no code of the signed-in app (`bun scripts/page-modules.ts`) and that no page's startup JavaScript exceeds its gzip budget in `scripts/first-load-js-budget.json` (`bun scripts/first-load-js.ts --budget scripts/first-load-js-budget.json`), and retains failed browser-test artifacts.

See [the web app README](apps/web/README.md) for the code layout and database development commands.

## License

Nimbus is released under the [MIT License](LICENSE). Bundled third-party assets keep their own licenses, listed under `apps/web/public/licenses`.
