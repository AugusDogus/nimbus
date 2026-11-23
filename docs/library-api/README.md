# Libraries and paired devices

Nimbus can offer chosen folders, read-only, to apps and devices that pair with it: a tablet on a kitchen wall, a reader, a script on another machine. This document is for anyone writing such a client. [`openapi.yaml`](openapi.yaml) is the exact contract, and [`fixtures/`](fixtures) has example responses.

- A **library** is a named set of folders that one Nimbus account offers. The account's owner creates it in Settings, Libraries, and chooses its folders in order. Everything in those folders and their subfolders is included, including files added later.
- A **paired device** signs in once, with a code its owner approves on a signed-in phone or browser, and then holds one opaque token bound to exactly one library. It sees only that library and can change nothing.

All endpoints are under `/api/library/v1` on the server's public HTTPS address.

## Pairing

1. The device calls `POST /pair/start` with `{ "deviceName": "Kitchen tablet" }`. The name is shown to the person approving, labeled as supplied by the device.
2. It shows the `pairingCode` (such as `B7KD-M4Q9`) and the `verificationUrl`, and may show `verificationUrlComplete` as a QR code. Codes expire after `expiresIn` seconds (10 minutes). Never show or log `deviceCode`: it is the device's secret.
3. The owner opens the address on a phone or browser, signs in to Nimbus as usual (with their second factor, if they have one), checks the request and chooses a library, then Allow or Deny. Opening the address approves nothing.
4. Meanwhile the device calls `POST /pair/poll` with `{ "deviceCode": "..." }` every `interval` seconds (5). The answer is `pending`, `denied`, `expired`, or `approved` with the device's `token` and its `library`. An early poll gets 429 `slow_down` with a larger `interval`, which then applies to every later poll.

Until the device collects its token, the owner sees it in Settings, Libraries as waiting for the device, and can cancel it there; the device's next poll then answers `denied`. The device name may not contain control characters, invisible formatting characters such as bidirectional marks, or line breaks.

The token is returned exactly once. If that response is lost, start pairing again. An unknown or already collected code reads as `expired`.

## The token

Send it as `Authorization: Bearer <token>` on every other endpoint. Store it in the platform's secure storage, never in logs.

- There is no refresh or renewal: the token stays valid until it is revoked or goes unused for 30 days. Each successful request moves that 30-day deadline forward.
- It ends at once when the owner disconnects the device or deletes its library in Settings, changes or resets their password, has their second factors reset, signs out everywhere, or has their account disabled.
- Every request checks the token, the account and the library against the server. The answers are `401` with code `authorization_required` (no token sent), `token_invalid` (not a token this server knows) or `token_revoked` (it was valid once). In every case, pair again.

## Endpoints

| Method and path | Answer |
| --- | --- |
| `POST /pair/start` | `{ deviceCode, pairingCode, verificationUrl, verificationUrlComplete, expiresIn, interval }` |
| `POST /pair/poll` | `{ status }`, with `token` and `library` when `approved` |
| `GET /me` | `{ deviceName, library: { id, title } }` |
| `GET /library` | `{ library, items, generatedAt }`; optional `?kinds=video,document` |
| `GET /items/{id}` | One item, as the library lists it |
| `GET`, `HEAD /items/{id}/file` | The file's bytes, see [Files](#files) |
| `GET`, `HEAD /items/{id}/poster?w=` | A JPEG poster, see [Posters](#posters) |
| `POST /items/{id}/stream` | `{ url, expiresAt }` and a cookie: a media address, see [Media addresses](#media-addresses) |
| `GET`, `HEAD /media/{id}?ticket=...` | The file's bytes for a media address and its cookie, without the token |

`GET /library` and posters answer with `Cache-Control: private, no-cache` and an `ETag`; send `If-None-Match` to get `304 Not Modified` when nothing changed. Every other answer is `private, no-store`.

## The library

`GET /library` returns one complete list of the regular files under the library's folders, newest first: by `addedAt` descending, then `id` ascending. There is no paging; a library may hold at most 2,000 files, and a larger one answers `422 library_too_large` rather than a partial list. Hidden files and folders (names starting with a dot) and files more than 32 folders deep below a library folder are not listed. A folder that is missing contributes nothing and comes back when its path exists again, so the list can be empty. A folder its owner can no longer share contributes nothing either, and nothing about it shows: not its files, not their number, not changes to them.

Each item has:

| Field | Meaning |
| --- | --- |
| `id` | Opaque and random. Kept through renames and moves; see [Identity](#identity). |
| `name` | The file's real name, extension included. |
| `kind` | `video`, `audio`, `image`, `document` or `other`, from the name. |
| `contentType` | The type Nimbus serves the file as, such as `video/mp4` or `application/pdf`. |
| `folder` | Which of the library's folders holds the file: `0` for the first, in the owner's order, counting only the folders the device sees now. Two folders with the same name are told apart by it. |
| `path` | The file's path below that folder: its real names joined with `/`, no leading slash, such as `Guides/Trail map.pdf`, or just its name at the top of the folder. Nothing at or above a library folder is shown. |
| `addedAt` | When the file joined the library; see [Identity](#identity). It never changes afterwards, also when the file is edited. |
| `sizeBytes`, `version` | Size, and an opaque value that changes whenever the content may have changed or the file moved, also when its id moved with it. |
| `poster` | `{ url, width, height }`, or `null` when the item has no poster; see [Posters](#posters). |

### Identity

Ids and added dates survive renames and moves made through Nimbus, and a folder disappearing for a while and returning. They also survive a rename or move made outside Nimbus (over a network share, by a sync tool, directly on disk) when the file's size and modification time are unchanged and the match is unambiguous. No file's content is read for this.

- **Added dates.** A file found when a folder is first scanned, which happens when the folder is added to a library (or the library is created) and exists, is dated by its modification time, never later than the moment of the scan. A file that appears later is dated when the library first sees it, even when its modification time is older, as for a file copied in with its original dates.
- **Edits.** A file changed in place keeps its id and added date; its `version` changes.
- **Returns.** A file that disappears is remembered, unlisted and unreachable, for 30 days. When a file appears again at the same path with the same size and modification time, it gets its id and added date back, as when a folder was briefly unavailable.
- **Renames and moves outside Nimbus.** A file that appears at a new path takes over the id and added date of a file that disappeared from the same library, at that moment or within the 30 days before, when all of these hold: both paths are inside the library's folders currently offered, the size is above zero and size and modification time are equal, it is the only new file with that size and time, and the one it takes over is the only file that disappeared with them. A file returning to its own old path takes precedence. A move into another library, or between an offered folder and one not currently offered, is a new item.
- **Otherwise a new item.** A different file at an old path, or a file at a new path that matches no file that disappeared, is a new item.

A different file that happens to have exactly the same size and modification time as one that disappeared, with no other candidate, inherits its id and added date. This stays within one library and the folders it offers, so it can change which item a device sees under an id, never what a device may reach.

## Files

`GET /items/{id}/file` sends the file's bytes with the token, for clients that can send an Authorization header. It answers as a file download does: the item's `contentType`, `Content-Length`, `Accept-Ranges: bytes`, a single byte range (`bytes=0-1`, `bytes=1000-`, `bytes=-500`) as `206` with an exact `Content-Range`, `416` with `Content-Range: bytes */<size>` for a range past the end, `HEAD`, and `If-Range`. The `ETag` is the item's `version`, quoted, and the answer is `Cache-Control: private, no-cache`. An id that is unknown, from another library, of a file that went missing, or of a file the device can no longer see all answer the same `404 item_not_found`. Every answer, whole or ranged, goes out with its exact length and is checked immediately before it is sent; a disconnect, a library change or a file change applies from the next request.

## Posters

Videos, PDFs and images have a poster: a JPEG of a frame a few seconds into the video, of the PDF's first page, or of the image, each in its own shape. The item's `poster` gives:

- `url`: the poster's path on this server, `/api/library/v1/items/{id}/poster`. Fetch it with the token, adding `?w=400`, `?w=800` or `?w=1920` for the width in pixels. Any other number rounds to the nearest of those (halfway rounds up), and without `w` the poster is 800 pixels wide. A poster is never larger than its source: a 640-pixel video gives a 640-pixel poster at `w=800`. A page has no pixels of its own and is drawn at the width asked for.
- `width` and `height`: the source's size, so a client can lay the item out before the poster loads. For a video, its frame as displayed; for an image, its size once its orientation applies; for a PDF, its first page in points (1/72 inch). They are `null` until the item's first poster has been drawn, then filled in: the listing never decodes a file, so asking for any poster of an item is what fills them in. Lay such an item out at a default shape and adjust when the poster arrives.

`poster` is `null` for audio, other files, documents that are not PDFs, video and image formats Nimbus cannot decode (such as AVI or HEIC), on a server without the decoders, and once a version of the file could not be drawn.

The poster answer has `Content-Type: image/jpeg`, an exact `Content-Length`, an `ETag` that changes with the item's `version` and the width, `Cache-Control: private, no-cache` and `X-Content-Type-Options: nosniff`; send `If-None-Match` for `304`. `HEAD` gives the same headers.

- **The first request may take a moment.** An item's first poster is drawn when it is asked for, then kept until the file changes, so later requests, at any width, are quick. A client may ask for all the posters of a screen at once: each device has up to four drawn at a time, the rest wait their turn (up to 64), and requests for the same poster share one drawing.
- **Busy.** When the server is drawing too many posters to queue more, it answers `429 rate_limited` with `Retry-After`; ask again then.
- **Failures.** A file that cannot be drawn answers `422 poster_failed`, and so does every later request until the file changes; its `poster` becomes `null`. A drawing that runs out of time answers `poster_failed` too, and is tried once more after ten minutes. An item without a poster answers `404 poster_not_available`. An id the device cannot reach answers `404 item_not_found`, as everywhere else.

## Media addresses

Some media players cannot add an Authorization header to the requests they make for a file. For them, `POST /items/{id}/stream` (with the token) returns `{ url, expiresAt }` and sets a cookie. The address is on the same server, `/api/library/v1/media/{id}?ticket=...`; pass the cookie with every request for it, as the player's cookie option allows. A request needs both: the address alone, as it might appear in a log, is refused, and the cookie only works with the address it came with.

- **Lifetime.** Four hours from minting (an hour longer than the file's duration once durations are known, at most eight hours), and never past the device's idle deadline. The cookie's `Max-Age` is no longer. Mint a new address after `stream_expired`.
- **Cookie.** A random 256-bit value that Nimbus does not store; the address carries only its hash. It is named `__Secure-nimbus-media-<session>`, with `Secure; HttpOnly; SameSite=Strict; Path=/api/library/v1/media` and no `Domain`. Over plain HTTP on the server's own machine, as in development, the name has no `__Secure-` prefix and the cookie no `Secure`.
- **Checked on every request.** The ticket, its cookie and their expiry; the device (not revoked, not idle, its account enabled); the item (still in the library and visible to the device); and the file's version. A changed file answers `409 stream_source_changed`: mint again. An invalid ticket or cookie answers `403 stream_invalid`, an expired one `403 stream_expired`, and a disconnected device `401 token_revoked`, also when its ticket expired too.
- **Ranges.** A ranged request is answered in full, as `206` with an exact `Content-Range` and `Content-Length`, whatever its size; only the file's end limits it. `HEAD` states exactly what `GET` sends. A request without a range gets the whole file, sent in chunks without `Content-Length`.
- **Stopping.** Disconnecting a device, or any other end of its sign-in, refuses its next request at once. A ranged answer already being sent cannot be stopped: a revocation, a library change or a file change takes effect on the next request. A whole file sent in chunks (a request without a range) stops between chunks when the device is disconnected, its library changes so the file is no longer in it, or the owner may no longer share or read it. Bytes already sent cannot be taken back.
- **Limits and restarts.** A device holds at most four addresses (a new one replaces its oldest). There is no limit on answers open at once: players hold several ranges open while they buffer; the request rate limits below apply. Addresses belong to one run of the server: an update the server makes without stopping keeps them working, also for answers already being sent, but after a restart every one answers `stream_expired`, and the client mints again.

## Errors

Every failure is JSON `{ "error": { "code": "...", "message": "..." } }`, with a stable `code` to branch on and a `message` for people that never contains paths or credentials. `slow_down` also carries `interval`. Every 429 carries `Retry-After`.

| Status | Codes |
| --- | --- |
| 400 | `invalid_request` |
| 401 | `authorization_required`, `token_invalid`, `token_revoked` |
| 403 | `forbidden_origin` (a web page on another site sent the request), `stream_invalid`, `stream_expired` |
| 404 | `not_found`, `item_not_found`, `poster_not_available` |
| 405 | `method_not_allowed` |
| 409 | `stream_source_changed` |
| 422 | `library_too_large`, `poster_failed` |
| 429 | `rate_limited`, `slow_down` |
| 503 | `library_unavailable` (the owner can no longer share any of the library's folders), `service_unavailable` |

## Limits

| Operation | Limit |
| --- | --- |
| `POST /pair/start` | 5 per 10 minutes per network address, 100 per 10 minutes for the server, at most 200 open requests |
| `POST /pair/poll` | The request's interval, from 5 seconds, plus 30 per minute per address |
| Looking up, allowing or denying a code | 5 each per 10 minutes per account and per address, 100 per minute for the server |
| Requests with a token | 120 per minute per device |
| Minting media addresses | 10 per minute per device |
| File and media byte requests (each range one) | 300 per minute per device |
| Poster requests | 300 per minute per device; four drawn at once per device |

## What a device can reach

A device's token becomes a read-only view of its library, checked on every request: the token must be live, its account active, the file inside one of the library's folders that the owner may still share, readable by the owner, not hidden, part of that library's catalog, and a regular file opened without following symbolic links anywhere on its path. Owning an administrator account does not widen it. No endpoint takes a path or a library id from the client. Folders that hold every account's home folder, the top of the drive, and other accounts' homes cannot be library folders, and only someone who may share a folder may add it, as for public links. Adding a folder to a library that already has paired devices asks the owner to confirm, naming those devices; removing one takes effect at once.

A file with more than one name (a hard link) is offered only when its other names are Nimbus's own upload staging, which a just-uploaded file keeps for up to a day. Any other second name, which could be outside the library, keeps the file out of the library: it is not listed, and its id answers `404 item_not_found`.
