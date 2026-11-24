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

**Privileges: not separated yet.** Today the supervisor and the servers run as one user (`PUID`),
so a compromised server could rewrite an installed release and have its code run at the next
handover or restart. Installed releases are verified again before every start, against the
signed manifest kept inside them, but files a server changes after that check, or modules it
loads later, are not caught. The plan, not built yet because it changes how the image runs and
can only be tested in CI's image check:

- the entrypoint starts the supervisor as a dedicated user (`nimbus-update`, uid 1100, no login,
  not in `PGID`'s group) holding only `setuid` and `setgid`, and the supervisor starts every
  server through `setpriv` as `PUID:PGID` with no capabilities (both checked by hand in a user
  namespace: the supervisor's effective set is exactly those two, the server's is empty);
- the installer runs as `nimbus-update` with no capabilities;
- the supervisor's lock and the releases move into `<config>/supervisor/`, owned by
  `nimbus-update`; the config root becomes `root:PGID` with mode `1775` (sticky, as `/tmp`), so the
  servers still create their files there but cannot rename, replace or remove what they do not
  own. That changes the config folder's owner and mode on the host;
- the supervisor can no longer open the servers' lease files, so it checks for servers left
  running by asking a short helper started as `PUID`.

**Persistence.** Installed releases live in `<config>/releases` (or NIMBUS_RELEASES_DIR), so they survive a container being
recreated. On start the supervisor runs the newest installed release that this image can run and
whose signed manifest still verifies, falling back to the built-in release, which it also starts
when the image's own build is as new or newer (a newer image was pulled). Not built yet: a server
refusing to start on a database a newer release migrated, as can happen when the container is
recreated from an older image while a newer release's migrations are in the database.

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
the data and the database, as before. Today they can also write the installed releases, since the
supervisor runs as the same user: a release they change no longer verifies at the next start, but
one they change after that check, or a module loaded later, runs their code again. The privilege
separation above is what closes that. They cannot make the supervisor install anything unsigned:
the supervisor and the installer verify every manifest against the image's trust root, which a
server cannot change, and the control socket is not reachable from a server's network.

**An attacker who controls the update source and serves a release that needs a newer image**
gets it reported, not installed.

## Not covered

- Freeze attacks beyond showing the time of the last check.
- A malicious but validly signed release.
- A compromised server rewriting installed releases, until the privilege separation above is built.
- Redirects: a source may redirect a fetch anywhere, as GitHub does to its storage. Integrity does
  not depend on where bytes come from, but an administrator who configures a hostile source lets it
  make the server request any address.
