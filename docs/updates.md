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

**Privileges: the supervisor, the update store and the servers run as different users.** Before,
the supervisor and the servers ran as the same user (`PUID`), so a compromised server could have
rewritten the releases it would be started from next. Now the entrypoint starts the supervisor as
a dedicated user (`nimbus-update`, uid 1100, no login, not in `PGID`'s group) holding only the
capabilities to change user (`setuid`, `setgid`), and the supervisor starts every server through
`setpriv` as `PUID:PGID` with no capabilities at all. The supervisor's downloads and unpacking run
in a child process as `nimbus-update` with no capabilities either. Releases live in
`<config>/releases`, owned by `nimbus-update` and readable by everyone; the config root itself
becomes `root:PGID` with mode `1775` (sticky, as `/tmp`), so the servers still create their files
there (the database and its journals, backups, caches) but cannot rename, replace or remove what
they do not own, such as `releases`. The image's own files are root's and read-only to both.

**Persistence.** Installed releases live under the config root, so they survive a container being
recreated. On start the supervisor runs the newest installed release that this image can run and
whose signed manifest still verifies, falling back to the built-in release. A server refuses to
start on a database that a newer release migrated (one with migrations it does not know), and
says what to do, rather than run older code against a newer schema.

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
and compares the SHA-256 before anything is unpacked. Unpacking accepts only regular files,
directories and symbolic links whose targets stay inside the release, refuses absolute paths and
`..`, and writes into `releases/.staging-<build>`; the tree is checked (the server's entry point,
`release.json` naming this supervisor protocol, the manifest's build), the native modules are
linked from the image, and only then is it renamed to `releases/<build>`. The supervisor then
hands over to it. Any failure leaves the running server as it was and the staging directory
removed; a release that never becomes ready is abandoned as any handover is.

Rollback hands over to the previous installed release. The installation keeps the three newest
releases and any release a server still runs.

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
the data and the database, as before. They cannot rewrite the releases or the supervisor, so a
restart of the container or a handover does not keep their code running: the next server starts
from a verified release. They can ask the supervisor over IPC to check, install or roll back, but
only to releases that verify, so at most they can make it install a newer signed release, or go
back to one already installed.

**An attacker who controls the update source and serves a release that needs a newer image**
gets it reported, not installed.

## Not covered

- Freeze attacks beyond showing the time of the last check.
- A malicious but validly signed release.
- Hosts that run Nimbus without the image's entrypoint: the privilege separation needs it, and
  without it the supervisor and the servers run as one user, as before.
