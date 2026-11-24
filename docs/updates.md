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
it lives in a GitHub environment (`release-signing`) that only the signing job on `main` may
use, separate from the token that uploads release assets. CI also attaches a GitHub
build provenance attestation to every bundle for anyone who wants to check it by hand; the
supervisor does not depend on it. The trust root lists keys by id, so a key is rotated by
shipping an image that trusts the new key alongside the old one, then one that trusts only the new.

**Privileges.** Started as root (the default, with `PUID` and `PGID`), the entrypoint leaves the
config root exactly as earlier images do, prepares the update store (below), clears the
supervisor's supplementary groups and execs it as root with `no_new_privs` and a bounding set of
four capabilities, each for one part of its job:

- `setuid` and `setgid`: to start servers as `PUID:PGID` and the installer as the update user;
- `setpcap`: for those children to empty their own bounding sets as they start;
- `kill`: to signal servers, and every process of the update user, which run as other users.

A process with `setuid` and `setgid` can become any user, so the supervisor is as good as root;
what keeps it safe is that its job is small and fixed. It verifies signatures and tree digests,
copies a staged release into the store, writes its own state, starts children with dropped
privileges and passes signals. It opens nothing in the config root, which the servers' user
owns: the installation lock and the leases are held and checked by a helper started as
`PUID:PGID` (`installation.ts`), which lives as long as the supervisor. It never parses a bundle
and never makes a network request.

Every child runs through `setpriv` with its ids, no supplementary groups, no capability in any
set, an empty bounding set and `no_new_privs`, and is checked to: a server whose
`/proc/<pid>/status` says otherwise is stopped at its first message, before the supervisor acts on
anything it says, and the installer is checked before it is given its request. `setpriv` itself
fails rather than run a child it could not drop.

- **Servers** run as `PUID:PGID`, as before.
- **The installer** (`installer.ts`) runs as the update user, `nimbus-update` (uid and gid
  1100, created by the image, no login, no home, no process except while an install runs). It
  alone touches the network and a bundle's bytes: fetching, following redirects, decompressing
  and unpacking. It gets an allowlisted environment (no application secret), the staging folder as
  its home, temporary folder and working folder, and only pipes: its request on standard input,
  its answer, data that is checked and never a path or command, on standard output.

How the mode is chosen is decided once, from canonical numeric ids (`Users`): started as root,
the users are split, and without `NIMBUS_SERVER_UID` and `NIMBUS_SERVER_GID` (the entrypoint sets
them from `PUID` and `PGID`) the supervisor refuses to start rather than run servers as root. A
`PUID` or `PGID` of 1100, the update user's id, turns updates off. Started as another user, as
with `docker run --user`, every process runs as that one user: a server could then rewrite the
release it would run next, so in-app updates are off, and the log says so once, with how to turn
them on. A container without the four capabilities (a `cap_drop`) starts the same way, as one
user with updates off; nothing's ownership is changed to make up for it.

**The update store.** Installed releases live in `/var/lib/nimbus`, which the image creates:

- `/var/lib/nimbus` and `releases/` belong to root, mode 755, with root-owned image folders
  above; `releases/` holds the installed releases (folders 755, files 644 or 755, set explicitly
  by root, whatever the umask) and `state.json` (the watermark, the pending, current and previous
  release, the schedule), written only by root, one durable write at a time;
- `staging/` belongs to the update user and root's group, mode 750: the only place the update
  user can write, and closed to the servers' user.

The servers' user can read and traverse `releases/` and nothing more; neither it nor the update
user can change anything that runs or anything that guards downgrades. By default the store is in
the container's own file system, so a recreated container starts with an empty one. To keep
installed releases across recreation, mount a volume at `/var/lib/nimbus`: a named volume takes
the image's layout when it is first used; for a bind mount the entrypoint makes that one folder
root's and creates `releases/` and `staging/` in it once, touching nothing else and re-owning
nothing recursively. A store laid out otherwise (another owner, a folder others may write, a link)
is left as it is: the supervisor says why and turns updates off, and installed releases that
verify still start.

Without a store volume, recreating the container loses the installed releases and the watermark:
the image's built-in release runs if the migration guard allows it (otherwise it refuses, saying
to pull the newer image), and the watermark starts again from the image's own build. A release
between that build and the one that ran before could then be offered again; the migration guard
still keeps an older release off a database a newer one migrated.

**Older images.** The config root is left as earlier images leave it, so an older image runs on
the same volumes as before and ignores the store. The database is the one thing an older image
cannot simply take back: a server refuses to start on a database a newer release migrated,
unless that release declared those migrations safe beside an older server (and the SQL of every
migration it knows matches the hash recorded when it was applied), and says to run the newer
release or restore the backup taken before them. Images from before that guard start anyway, so
going back across a migration means restoring that backup first.

**Persistence.** On start the supervisor runs the newest installed release that this image can
run and whose signed manifest and tree still verify, falling back to the built-in release, which
it also starts when the image's own build is as new or newer (a newer image was pulled).

**Test seams.** The real-process tests run from a source checkout and inject what an image never
has: `NIMBUS_TEST_STORE_DIR`, `NIMBUS_TEST_RELEASE_KEYS_FILE`, `NIMBUS_TEST_RELEASES_DIR`
(unsigned releases a `restart <name>` may start, never a rollback or a boot) and
`NIMBUS_TEST_UPDATES_WITH_ONE_USER`. They are honoured only when the built-in release's root holds
`.git`, which images and installed releases never do; elsewhere they are refused with one log
line. Pruning removes only installed releases whose signed manifest verifies under their name,
and only the installer's own attempt folders.

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

Installing runs in two processes. The installer, as the update user, streams the bundle to a
file in staging, refuses more bytes than the manifest's size, writes every byte it received (a
write near a full disk may take only part of a chunk), and compares the size and SHA-256 of the
file as it is on disk before anything is unpacked. Unpacking accepts only regular files,
directories and symbolic links whose targets stay inside the release, refuses absolute paths and
`..`, caps entries, depth and size, and writes into `staging/release`; it checks that tree too,
but nothing it leaves is trusted.

Root then publishes it. It stops every process of the update user (each pass signals them all at
once from a process of that user, `kill(-1)`, which the kernel applies in one sweep, then looks
again; one still running after ten passes fails the install), so nothing can change the staged
tree while root reads it. It copies the tree into a folder of its own under `releases/`, holding
each folder open and opening what is in it through that descriptor without following links,
accepting only regular files with one link, folders and symbolic links, each owned by the update
user and without set-id bits, under the archive's caps again; links are recreated as links and
checked once the copy is complete. In root's copy it checks the tree digest against the signed
manifest, the absence of native binaries (by ELF, Mach-O and PE headers), the server's entry point
and `release.json`, and the build; it links the image's native modules, writes the manifest and
signature it verified itself, and only then renames the copy to `releases/<build>`. The installer
then removes what it staged. The supervisor then hands over to it. Any failure before the
handover, or during it, leaves the running server as it was, `releases/` and `state.json`
unchanged, and the partial copy removed; a release that never becomes ready is abandoned as any
handover is. One exception: a release whose migrations are not safe beside an older server gets
a full restart, which stops every server before starting it. Once that has happened the earlier
release may not run on the database, so a new release that then fails is retried rather than
replaced by the earlier one, and the supervisor says how to go back (restore the backup taken
before the migration). The target is written to the state as pending before any server stops,
and recorded as running when it takes over, also when that happens on a later retry, so a
container stopped in between boots the target, never the earlier release. A handover is reserved
before anything is downloaded or written for it, so a request refused as busy changes nothing.

Before any installed release starts, every time (at boot, for a handover or rollback, for a
restart after a crash or SIGHUP), the supervisor checks it again, without following links:
its manifest's signature, and the whole tree against the tree digest the manifest signed
(`ReleaseTree`: every file's content and executable bit, every folder, every link target, so a
changed, missing or extra entry shows), leaving out only the installer's copy of the manifest and
the native links, which must lead to the image's copies. A release that fails is not started; the
supervisor starts the built-in release instead and says why, also when the failure comes at a
restart after a crash, rather than retrying it. The one exception is a release a full restart has
migrated for, which is retried as described above. The manifest carries one digest and
an entry count rather than a list of files: about 100 bytes, where a list would be some 3 MiB for
24,000 entries. The check reads the whole release (about 190 MiB): it is what each start costs.

The watermark (the highest sequence run, kept per repository and channel in
`releases/state.json`) only rises. The image's own build is recorded in it before anything
serves, so an older image pulled later keeps the floor a newer one set. Once a release is
installed, whether it is still newer is decided in the same queued write that reserves its
sequence, against what ran by the time that write's turn comes, and that write is durable (fsync
of the file and its folder) before the handover starts, so no failure after that lets an older
build be offered again. State writes are made one at a time, each through a temporary file of its
own, and a write that fails fails the step that needed it. If the state file is damaged or cannot
be read, the supervisor starts the built-in release and installs and rolls back nothing, since it
can no longer tell an update from a downgrade; it says so, and leaves the file for an
administrator to remove (which restarts the watermark from the image's own build).

Rollback hands over to the previous installed release, verified through the same path as an
install, and fails when it is no longer installed. The installation keeps the three newest
releases and any release a server still runs.

## Publishing

Only pushes to main publish, as the `edge` channel, once `verify` passed. Three jobs in
`.github/workflows/ci.yml` do it:

- `bundle` builds the bundle with `scripts/release-bundle.ts`, records the digests of the bundle
  and manifest, uploads both as one artifact before anything runs them, and attaches a build
  provenance attestation. It installs packages, so no secret is present in it.
- `smoke` downloads that artifact by id, checks it against those digests, and starts it once as
  a real server (`scripts/release-smoke.ts`, which checks the bundle's size, SHA-256 and tree
  against the manifest first, and gives the server no environment of the job).
- `sign` is the only job in the `release-signing` environment, and waits for both. It installs
  nothing and runs no code from the bundle: it checks that the artifact's stored digest is the one
  uploaded, downloads that same artifact by id, checks the files against the digests, signs the
  manifest with `scripts/release-sign.ts` (which imports nothing; plain Bun and WebCrypto) only
  if its repository, channel, commit and sequence are the workflow's own (`github.repository`,
  `edge`, `github.sha`, `github.run_number`), and uploads bundle, signature and manifest, in that
  order, to the release `channel-edge`.

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

A fork or mirror that signs with its own key builds its own image with its own
`apps/web/release-keys.json`; an image trusts only the keys it was built with.

## Updates from Settings

Administrators see and drive updates in Settings, Administration (`/api/admin/updates`: a
signed-in administrator's session, never a paired device or an app password; changes only from a
Nimbus page). The server asks its supervisor over the supervisor protocol, with a closed set of
requests and no free-form argument (`update-protocol.ts`): `status`, `check`, `install` (the
release the last check offered), `rollback` (the recorded previous release) and `schedule` (off,
notify only or install at an hour, 0 to 23). No request names a release, a path or a URL. The
supervisor validates every field, refuses unknown ones, and limits each kind: 60 status requests
per 10 seconds, 3 checks, 2 installs, 2 rollbacks and 10 schedule changes a minute, from all
servers together.

So a compromised server can, through this, at worst cause a check of the configured source, an
update to the newest signed release newer than anything run here (which the administrator would
also be offered), a rollback to the previous signed release (and back again, as rollbacks
alternate), or a different schedule, each within those limits and each through the verified
paths above. It cannot install anything unsigned or older than what ran, nor start a release by
name.

The schedule's default is notify only: the supervisor checks twice a day so Settings shows what
is available. Install at a quiet hour also checks again at that hour (in the server's time zone)
and installs what is offered, once a day. Outcomes go to the audit log: an administrator's
install or rollback with that administrator, the schedule's as the system.

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
Bundles are staged and unpacked in the update store, which users cannot reach through Nimbus.

**An attacker who controls a Nimbus server process** (remote code execution as `PUID`) can read
the data and the database, as before. They cannot write the installed releases or the state,
which are root's, nor reach staging, nor signal or trace the supervisor or the installer, which
run as other users; their servers hold no capabilities and cannot gain any (`no_new_privs`).
Under `--user`, where one user runs everything, updates are off for this reason. They cannot make
the supervisor install anything unsigned: root verifies every manifest against the image's trust
root, which a server cannot change, and the control socket, root's, is not reachable from a
server's network. What they can send the supervisor is the server protocol's messages, which it
parses as data; the update requests among them are a closed set (Updates from Settings) through
which the worst they can cause is an update to the newest signed release this installation has not
run, or a rollback to the previous signed one, at most twice a minute each. Root's own Bun runs
with a home only root may write, no transpiler cache, no variable that changes what Bun loads,
and a working folder the image owns (Bun 1.4.4 reads a `bunfig.toml` only from its working
folder), so nothing a server leaves in `/tmp` or elsewhere is loaded as root.

**An attacker who exploits the installer** (through the network, a redirect or a hostile bundle,
as the update user) can write only staging, and only while the install runs: root stops every
process of that user before it reads what was staged, copies it without following links or
accepting anything but plain entries the update user owns, and checks the copy against the signed
manifest. They cannot change a published release, the state or the watermark, which are root's,
nor read the application's secrets, which the installer is not given. Hostile bytes reach the
installer only through Bun's HTTP client, the hashing of the download, and, once the bundle's size
and SHA-256 match its signed manifest, decompression and unpacking: nothing is decompressed before
that check. Root receives only the manifest and signature as bounded bytes; it parses the
signature's small JSON envelope, verifies the signature over the manifest's exact bytes, and only
then parses the manifest.

**An attacker who controls the update source and serves a release that needs a newer image**
gets it reported, not installed.

## Not covered

- Freeze attacks beyond showing the time of the last check.
- A malicious but validly signed release.
- A compromised server under `--user`: one user runs everything, so it could rewrite installed
  releases; updates are off there.
- A compromised supervisor: it is root with `setuid` and `setgid`, so it can become any user in
  the container. Its job is kept small so that it stays hard to compromise.
- A container recreated without a store volume: see The update store.
- A compromised installer runs as an unprivileged user in the same container: it can read files
  other users made world-readable and can reach the network, as any process there can.
- A compromised server can deny service through the installation lock and lease helper, which
  run as its own user. It is the server; it can already stop serving.
- Ownership: as root, the entrypoint gives only the data and config roots themselves to
  `PUID:PGID`, and only when no folder above them could be changed by that user; it never changes
  ownership inside them, so after a `PUID` change the operator re-owns Nimbus's state.
- Redirects: a source may send a fetch on, as GitHub sends release downloads to its storage, at
  most three times, and only to https addresses whose host resolves to public addresses alone:
  never this machine, a private or link-local network, carrier-grade NAT or a cloud metadata
  service. The configured source itself is the administrator's choice and may be on the local
  network, such as a mirror. A host is resolved once to check it and again by the fetch, so a
  name whose address changes in between (DNS rebinding) is not caught; integrity never depends on
  where bytes come from, but such a source could make the server request an address it chose.
  Error messages name the file fetched, never the source's address.