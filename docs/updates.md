# In-app updates

Nimbus can update itself from inside the running container, without downtime: the supervisor
downloads a release bundle, verifies it, and hands over to it as `control.ts restart` does. This
document is the design and its threat model. It is written for whoever reviews or changes the
update path; the README says how to use it.

## Pieces

- **Image.** The container image built by CI. It carries Bun, the native modules (sharp and
  libvips), FFmpeg and Poppler, the supervisor, the built-in release, and the **trust root**: the
  public keys release bundles must be signed with (`apps/web/release-keys.json`). The supervisor
  always runs the image's code; a bundle never replaces it.
- **Release bundle.** One build of the server and its built client, as a gzip-compressed tar:
  the source tree (as in the image), `apps/web/dist`, and the production dependencies the server
  actually imports. It carries no native binaries: those come from the image, and the bundle
  states which versions it needs. CI builds one for every commit that passes `verify`, the gate
  the image is published behind.
- **Manifest.** A JSON document describing one bundle, signed with Ed25519. It names the build
  (sequence number, commit, channel, time), what the bundle needs from the image (Bun version,
  supervisor protocol, native module versions), its migrations and which of them are safe beside
  an older server, the commits since the previous build on its channel, and the bundle's file
  name, size and SHA-256.
- **Update source.** Where manifests and bundles are fetched from: a base URL serving
  `manifest.json`, `manifest.sig` and the bundle the manifest names. By default the GitHub release
  of the image's channel in the repository the image was built from (from its build metadata,
  never written into the code); `NIMBUS_UPDATE_SOURCE` points elsewhere, such as a mirror, or
  turns updates off (`off`).

## Choices

**Bundle shape: source tree plus pruned dependencies, not a bundled server.** A bundled server
(`bun build`) is 10 MB against about 300 MB of production dependencies, but the server locates
files relative to its own modules (`../dist/`, `../routes/`, `../../drizzle`) and starts workers
by file name (`new Worker(new URL("./search.worker.ts", import.meta.url))`); the bundler leaves
those references as they are, so a bundled server would look for files that are not there, and
would run in a shape no test runs. The bundle keeps the image's layout instead and removes every
dependency package the server's import graph does not reach, as the bundler reports it (build
tools pulled in as peer dependencies, such as TypeScript 7, esbuild, drizzle-kit and Vite, and
client-only libraries), plus the native packages, which the image provides.

**Signatures: one pinned Ed25519 key, not keyless Sigstore.** Keyless signing (GitHub artifact
attestations) needs no secret, but verifying it offline needs Sigstore's trust root, which
rotates through TUF and expires, and a Sigstore verifier, a large new dependency in the
supervisor. A pinned Ed25519 key verifies with WebCrypto, which Bun has, against a 32-byte key
the image carries; a fork pins its own key in its own image. The cost is a long-lived secret:
it lives in a GitHub environment (`release-signing`) that only the publishing job on `main` and
`v*` tags may use, separate from the token that uploads release assets. CI also attaches a GitHub
build provenance attestation to every bundle for anyone who wants to check it by hand; the
supervisor does not depend on it. The trust root lists keys by id, so a key is rotated by
shipping an image that trusts the new key alongside the old one, then one that trusts only the new.

**Privileges.** The servers cannot change what the supervisor installs. Started as root (the
default, with `PUID` and `PGID`), the entrypoint runs the supervisor as a user of its own
(`NIMBUS_UPDATE_UID`, default 1100: no name, no login, not in `PGID`'s group) holding only
`setuid`, `setgid` and `kill`, with `no_new_privs` and a bounding set of those three. The
supervisor starts every server through `setpriv` as `PUID:PGID` with no capabilities at all,
waits for servers of an earlier start through a short helper run as that user (their lease files
are theirs), and runs the installer as its own user with no capabilities. The layout this needs
is prepared once by the entrypoint, logged when it changes, and checked again at every start
without re-owning anything recursively:

- the config root becomes `root:PGID` with mode `1771`: sticky, as `/tmp`, so the servers still
  create their files in it but cannot rename, replace or remove what they do not own, and nobody
  else can list it (the server leaves a root shared this way as it is instead of making it `700`);
- `<config>/supervisor/` and `<config>/supervisor/releases/` belong to the supervisor's user,
  mode `755`. Anything already at `<config>/supervisor` that is not that user's folder, such as a
  link or a folder a server made, is moved aside as `supervisor.untrusted-<time>` and never used;
- the installation lock `<config>/server.lock` belongs to the supervisor's user and `PGID`, mode
  `660`, and is held without a journal file, since its holder cannot write the folder.

A container started with `--user` (or as `NIMBUS_UPDATE_UID` equal to `PUID` or `PGID`, or on a
config root that cannot be re-owned) still starts and serves, as one user: then a server could
rewrite the release it would run next, so in-app updates are off, and the log says so once with
how to turn them on (start as root with `PUID` and `PGID`). Installed releases still start, being
verified again before every start. `NIMBUS_UPDATES_WITH_ONE_USER=1` turns updates on anyway, for
development and tests only.

**Older images on the new layout.** An image from before this change, started as root, gives the
config root back to `PUID:PGID` and its server makes it `700` again, as before; it ignores
`<config>/supervisor`, and opens `server.lock` through `PGID`. Started with `--user` on the new
layout, it cannot make the root-owned config root private and refuses to start with a message
saying to give it to its user; nothing is changed. Starting this image again re-applies the
layout. The database is the one thing an older image cannot simply take back. A server now refuses
to start on a database a newer release migrated, unless that release declared those migrations
safe beside an older server, and says to run the newer release or restore the backup taken before
them; images from before that guard start anyway, so going back across a migration means
restoring that backup first.

**Persistence.** Installed releases live in `<config>/supervisor/releases`, which only the supervisor's user writes, so they survive a container being
recreated. On start the supervisor runs the newest installed release that this image can run and
whose signed manifest still verifies, falling back to the built-in release, which it also starts
when the image's own build is as new or newer (a newer image was pulled).

**Releases placed by hand.** `control.ts restart <name>` can also start a release an operator
put in NIMBUS_RELEASES_DIR, unsigned. That folder is never the installed releases' folder, and is
used only when it lies outside the data root (and does not hold it), and when it and every folder
above it belong to root or the supervisor's user and are writable by nobody else (a sticky folder
such as /tmp may be on the way). Otherwise it is ignored, with a log line saying why. Pruning
removes only installed releases: a release name with a signed manifest of its own.

## Rules

An update is offered only when every one of these holds:

1. `manifest.sig` is a valid Ed25519 signature of the exact bytes of `manifest.json` by a key in
   the image's trust root, named by its key id.
2. The manifest parses and names this image's channel.
3. Its sequence number is higher than that of every release this installation has run on the
   channel. A lower or equal one is never installed by a check, however it is signed: only an
   administrator's rollback starts an older release, and only one already installed here.
4. It needs this image's Bun version, supervisor protocol and native module versions; otherwise it
   is reported as needing a newer image, with the image tag to pull.

Installing then streams the bundle to a staging file, refuses more bytes than the manifest's size,
writes every byte it received (a write near a full disk may take only part of a chunk), and
compares the size and SHA-256 of the file as it is on disk before anything is unpacked. Unpacking accepts only regular files,
directories and symbolic links whose targets stay inside the release, refuses absolute paths and
`..`, and writes into `releases/.staging-<build>`; the tree is checked (the server's entry point,
`release.json` naming this supervisor protocol, the manifest's build), the native modules are
linked from the image, and only then is it renamed to `releases/<build>`. The supervisor then
hands over to it. Any failure before the handover, or during it, leaves the running server as it
was and the staging directory removed; a release that never becomes ready is abandoned as any
handover is. One exception: a release whose migrations are not safe beside an older server gets
a full restart, which stops every server before starting it. Once that has happened the earlier
release may not run on the database, so a new release that then fails is retried rather than
replaced by the earlier one, and the supervisor says how to go back (restore the backup taken
before the migration). The target is written to the state as pending before any server stops,
and recorded as running when it takes over, also when that happens on a later retry, so a
container stopped in between boots the target, never the earlier release.

Before any installed release starts, at boot or for a rollback, the supervisor checks it again:
its manifest's signature, and the whole tree against the tree digest the manifest signed
(`ReleaseTree`: every file's content and executable bit, every folder, every link target, so a
changed, missing or extra entry shows), leaving out only the installer's copy of the manifest and
the native links, which must lead to the image's copies. A release that fails is not started; the
supervisor starts the built-in release instead and says why. The manifest carries one digest and
an entry count rather than a list of files: about 100 bytes, where a list would be some 3 MiB for
24,000 entries. The check reads the whole release (about 190 MiB): it is what boot costs.

The watermark (the highest sequence run, kept per repository and channel in
`releases/state.json`) only rises. Once a release is installed it is checked again against the
watermark, since another release may have run meanwhile, and its sequence is written to the state
durably (fsync of the file and its folder) before the handover starts, so no failure after that
lets an older build be offered again. State writes are made one at a time, each through a
temporary file of its own, and a write that fails fails the step that needed it. If the state
file is damaged, the supervisor starts the built-in release and installs and rolls back nothing,
since it can no longer tell an update from a downgrade; it says so, and leaves the file for an
administrator to remove (which restarts the watermark from the image's own build).

Rollback hands over to the previous installed release. The installation keeps the three newest
releases and any release a server still runs.

## Publishing

Only pushes to main publish, as the `edge` channel, once `verify` passed. Two jobs in
`.github/workflows/ci.yml` do it:

- `bundle` builds the bundle with `scripts/release-bundle.ts`, starts it once as a real server
  (`scripts/release-smoke.ts`), attaches a build provenance attestation, and hands it on as an
  artifact with its digests as job outputs. It installs packages, so no secret is present in it.
- `sign` is the only job in the `release-signing` environment. It installs nothing and runs no
  code from the bundle: it checks the artifact against the digests the bundle job reported, signs
  the manifest with `scripts/release-sign.ts` (which imports nothing; plain Bun and WebCrypto),
  and uploads bundle, signature and manifest, in that order, to the release `channel-edge`.

The image built from the same commit carries the same sequence (the workflow's run number), so
it does not offer its own bundle as an update. Version tags build images with no build metadata,
which look for no update: a `stable` channel comes later, together with a protected tag ruleset,
so that whoever can push a tag cannot get a release signed. The manifest's channel field and every
check of it are already in place.

Setting it up once:

1. `bun scripts/release-keys.ts <key id> --private-key-file <path>` prints the public key entry
   and writes the private key to a new file only you can read (mode 600), never to the terminal.
2. Add the entry to `apps/web/release-keys.json` and commit it: images built from then on trust it.
3. Create the environment `release-signing`, limited to the `main` branch, with the secret
   `NIMBUS_RELEASE_SIGNING_KEY` (the private key file's content) and the variable
   `NIMBUS_RELEASE_KEY_ID`; then delete the file.

Until then `sign` stops before signing and nothing is published, and images trust no key.

A fork or mirror that signs with its own key points `NIMBUS_RELEASE_KEYS_FILE` at its own trust
root file instead of rebuilding the image. That file must belong to root or the supervisor's user
and be writable by nobody else, or Nimbus trusts no key at all.

## What the server sends

Checking for an update fetches `manifest.json` and `manifest.sig` from the update source, and
installing fetches the bundle: plain HTTPS GET requests with the user agent `Nimbus`, no cookies,
no query, nothing about the installation, its users or its files. With `NIMBUS_UPDATE_SOURCE=off`
the server makes no request for its own code at all.

## Threat model

**An attacker who controls the network** between the server and the update source can block,
delay, replay or alter responses. Altering a manifest or bundle fails the signature or the
digest. Replaying an older signed manifest offers nothing, because offers must have a higher
sequence than what was already run. Blocking or freezing updates (serving the last manifest
forever) cannot be prevented; the administrator sees when the last successful check was. A huge
or endless response is cut off at the manifest's size limit (64 KiB) or the bundle's stated size.

**An attacker who controls the GitHub release but not the signing key**, such as through a leaked
token with permission to upload release assets, can publish any file. Without the key no manifest
verifies, so nothing is installed. They can withhold updates or replace a bundle with garbage,
which fails its digest. The signing key is not available to that token: only the publishing job,
in the protected `release-signing` environment, can use it.

**An attacker who controls the signing key** can publish an update every installation trusts.
That is what the key is for; it is the single secret to protect, and rotating it needs a new
image. Build provenance attestations let anyone check after the fact that a bundle was built by
CI from a given commit.

**An attacker who can write files inside `/data`** (any Nimbus user who can upload, a WebDAV
client, a share) gains nothing over updates: the data root holds no part of the update path.
Bundles are staged and unpacked under the config root, which users cannot reach through Nimbus.

**An attacker who controls a Nimbus server process** (remote code execution as `PUID`) can read
the data and the database, as before. They cannot write the installed releases, the installer's
staging or the installation lock, which belong to the supervisor's user, nor signal or trace the
supervisor, which runs as another user; their servers hold no capabilities and cannot gain any
(`no_new_privs`). Under `--user`, where one user runs everything, updates are off for this reason. They cannot make the supervisor install anything unsigned:
the supervisor and the installer verify every manifest against the image's trust root, which a
server cannot change, and the control socket is not reachable from a server's network.

**An attacker who controls the update source and serves a release that needs a newer image**
gets it reported, not installed.

## Not covered

- Freeze attacks beyond showing the time of the last check.
- A malicious but validly signed release.
- A compromised server under `--user`, or with `NIMBUS_UPDATES_WITH_ONE_USER=1`: one user runs
  everything, so it could rewrite installed releases; updates are off there unless asked for.
- A compromised supervisor: it can start a server as `PUID:PGID` and signal any process in the
  container, as its three capabilities allow, and it installs releases.
- Redirects: a source may send a fetch on, as GitHub sends release downloads to its storage, at
  most three times, and only to https addresses whose host resolves to public addresses alone:
  never this machine, a private or link-local network, carrier-grade NAT or a cloud metadata
  service. The configured source itself is the administrator's choice and may be on the local
  network, such as a mirror. A host is resolved once to check it and again by the fetch, so a
  name whose address changes in between (DNS rebinding) is not caught; integrity never depends on
  where bytes come from, but such a source could make the server request an address it chose.
  Error messages name the file fetched, never the source's address.