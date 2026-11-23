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
| `GET /library/data` | The library's data file, see below |

`GET /library` and `GET /library/data` answer with `Cache-Control: private, no-cache` and an `ETag`; send `If-None-Match` to get `304 Not Modified` when nothing changed. Every other answer is `private, no-store`.

Planned for later versions, in this API's style: endpoints for one item, its original bytes, a preview image and this device's progress.

## The library

`GET /library` returns one complete list of the regular files under the library's folders, newest first: by `addedAt` descending, then `id` ascending. There is no paging; a library may hold at most 2,000 files, and a larger one answers `422 library_too_large` rather than a partial list. Hidden files and folders (names starting with a dot), files more than 32 folders deep below a library folder, and the library data file are not listed. A folder that is missing contributes nothing and comes back when its path exists again, so the list can be empty. A folder its owner can no longer share contributes nothing either, and nothing about it shows: not its files, not their number, not changes to them.

Each item has:

| Field | Meaning |
| --- | --- |
| `id` | Opaque and random. Kept through renames and moves made through Nimbus; see [Identity](#identity). |
| `name` | The file's real name, extension included. |
| `title` | A display title derived from the name; see below. |
| `kind` | `video`, `audio`, `image`, `document` or `other`, from the name. |
| `contentType` | The type Nimbus serves the file as, such as `video/mp4` or `application/pdf`. |
| `collection` | The folder directly under the library folder that holds the file, cleaned like a title, or `null` for files at the top. |
| `addedAt` | When the file joined the library; see [Identity](#identity). It never changes afterwards, also when the file is edited. |
| `sizeBytes`, `version` | Size, and an opaque value that changes whenever the content may have changed. |
| `subtitle`, `poster`, `media`, `pageCount`, `progress` | `null` for now. `media` will describe container, codecs, dimensions and duration, so a client can decide what it can play; `pageCount` a document's pages. |
| `isNew` | `true` while this device has no progress for the item. |

### Identity

Ids and added dates survive renames and moves made through Nimbus, and a folder disappearing for a while and returning. Renames and moves made outside Nimbus (over a network share, by a sync tool, directly on disk) currently produce a new item with a new id; this is to be improved before progress is kept.

- **Added dates.** A file found when a folder is first scanned, which happens when the folder is added to a library (or the library is created) and exists, is dated by its modification time, never later than the moment of the scan. A file that appears later is dated when the library first sees it, even when its modification time is older, as for a file copied in with its original dates.
- **Edits.** A file changed in place keeps its id and added date; its `version` changes.
- **Returns.** A file that disappears is remembered, unlisted and unreachable, for 30 days. When a file appears again at the same path with the same size and modification time, it gets its id and added date back, as when a folder was briefly unavailable.
- **Otherwise a new item.** A different file at an old path, or a file at a new path, is a new item.

### Display titles

The `title` is a convenience; clients that prefer the real name have `name`. It is derived in this order:

1. The final extension is removed (`report.final.pdf` becomes `report.final`). Text is normalized to NFC and control characters are removed.
2. A short leading sequence number and its separator are removed: a zero-padded number of 2 or 3 digits before any separator (`01 Getting started`, `02_Next steps`, `001 intro`), or an unpadded number of 1 to 3 digits before a spaced dash, a dot or a parenthesis followed by a letter (`3 - Follow up`, `1. Introduction`, `4) Wrap up`). A number that is part of the title stays (`2026 plan`, `101 questions`, `12 days of baking`, `3-step guide`, `1.5 cups of flour`), and so does a number that is the whole name (`7`, `05`).
3. Whole calendar dates at the start or end, written `YYYY-MM-DD`, `YYYY_MM_DD` or `YYYYMMDD`, are removed. Only real dates count, leap years included; a date in the middle stays.
4. Underscores and hyphens become spaces, runs of spaces become one, and separators left at either end are trimmed.
5. A name written all in capitals is put in sentence case, keeping `PDF`, `FAQ`, `USB`, `GPS`, `DIY`, `DVD` and words with digits as they are. A single capitalized word of up to five letters is kept as a possible acronym. Mixed case is kept as written.
6. If nothing readable is left, the title is the kind and the last six characters of the id, such as `Document ABC123`. Titles are at most 160 characters.

| File name | Title |
| --- | --- |
| `2026-10-08_sourdough-basics.mp4` | `sourdough basics` |
| `TRAIL_MAP_FOR_THE_NORTH_LOOP_20261101.PDF` | `Trail map for the north loop` |
| `01 Getting started.mp4` | `Getting started` |
| `3 - Follow up.mp4` | `Follow up` |
| `2026 plan.pdf` | `2026 plan` |
| `101 questions.pdf` | `101 questions` |
| `7.mp4` | `7` |
| `2026-02-29_notes.pdf` | `2026 02 29 notes` (not a real date) |
| `2024-02-29.pdf` | `Document ABC123` |
| `GPS_SETUP.mp4` | `GPS setup` |
| `version.2_notes.pdf` | `version.2 notes` |

## The library data file

`GET /library/data` serves an optional JSON document a library's owner can place at its root for client apps to use: the file `library.json` at the top of the library's first folder (the folders' order is the owner's). Nimbus does not interpret it and returns its bytes as stored, as `application/json`, at most 64 KiB. It answers `404 library_data_not_found` when there is no such regular file, and `422 library_data_too_large` when it is larger. The file is never listed as an item, and nothing else can be fetched this way.

## Errors

Every failure is JSON `{ "error": { "code": "...", "message": "..." } }`, with a stable `code` to branch on and a `message` for people that never contains paths or credentials. `slow_down` also carries `interval`. Every 429 carries `Retry-After`.

| Status | Codes |
| --- | --- |
| 400 | `invalid_request` |
| 401 | `authorization_required`, `token_invalid`, `token_revoked` |
| 403 | `forbidden_origin` (a web page on another site sent the request) |
| 404 | `not_found`, `item_not_found`, `library_data_not_found` |
| 405 | `method_not_allowed` |
| 422 | `library_too_large`, `library_data_too_large` |
| 429 | `rate_limited`, `slow_down` |
| 503 | `library_unavailable` (the owner can no longer share any of the library's folders), `service_unavailable` |

## Limits

| Operation | Limit |
| --- | --- |
| `POST /pair/start` | 5 per 10 minutes per network address, 100 per 10 minutes for the server, at most 200 open requests |
| `POST /pair/poll` | The request's interval, from 5 seconds, plus 30 per minute per address |
| Looking up, allowing or denying a code | 5 each per 10 minutes per account and per address, 100 per minute for the server |
| Requests with a token | 120 per minute per device |

## What a device can reach

A device's token becomes a read-only view of its library, checked on every request: the token must be live, its account active, the file inside one of the library's folders that the owner may still share, readable by the owner, not hidden, part of that library's catalog, and a regular file opened without following symbolic links anywhere on its path. Owning an administrator account does not widen it. No endpoint takes a path or a library id from the client. Folders that hold every account's home folder, the top of the drive, and other accounts' homes cannot be library folders, and only someone who may share a folder may add it, as for public links. Adding a folder to a library that already has paired devices asks the owner to confirm, naming those devices; removing one takes effect at once.
