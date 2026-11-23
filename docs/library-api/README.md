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

`GET /library` answers with `Cache-Control: private, no-cache` and an `ETag`; send `If-None-Match` to get `304 Not Modified` when nothing changed. Every other answer is `private, no-store`.

Planned for later versions, in this API's style: endpoints for one item, its original bytes and a preview image.

## The library

`GET /library` returns one complete list of the regular files under the library's folders, newest first: by `addedAt` descending, then `id` ascending. There is no paging; a library may hold at most 2,000 files, and a larger one answers `422 library_too_large` rather than a partial list. Hidden files and folders (names starting with a dot) and files more than 32 folders deep below a library folder are not listed. A folder that is missing contributes nothing and comes back when its path exists again, so the list can be empty. A folder its owner can no longer share contributes nothing either, and nothing about it shows: not its files, not their number, not changes to them.

Each item has:

| Field | Meaning |
| --- | --- |
| `id` | Opaque and random. Kept through renames and moves made through Nimbus; see [Identity](#identity). |
| `name` | The file's real name, extension included. |
| `kind` | `video`, `audio`, `image`, `document` or `other`, from the name. |
| `contentType` | The type Nimbus serves the file as, such as `video/mp4` or `application/pdf`. |
| `folder` | Which of the library's folders holds the file: `0` for the first, in the owner's order, counting only the folders the device sees now. Two folders with the same name are told apart by it. |
| `path` | The file's path below that folder: its real names joined with `/`, no leading slash, such as `Guides/Trail map.pdf`, or just its name at the top of the folder. Nothing at or above a library folder is shown. |
| `addedAt` | When the file joined the library; see [Identity](#identity). It never changes afterwards, also when the file is edited. |
| `sizeBytes`, `version` | Size, and an opaque value that changes whenever the content may have changed. |
| `poster` | `null` for now. |

### Identity

Ids and added dates survive renames and moves made through Nimbus, and a folder disappearing for a while and returning. Renames and moves made outside Nimbus (over a network share, by a sync tool, directly on disk) currently produce a new item with a new id.

- **Added dates.** A file found when a folder is first scanned, which happens when the folder is added to a library (or the library is created) and exists, is dated by its modification time, never later than the moment of the scan. A file that appears later is dated when the library first sees it, even when its modification time is older, as for a file copied in with its original dates.
- **Edits.** A file changed in place keeps its id and added date; its `version` changes.
- **Returns.** A file that disappears is remembered, unlisted and unreachable, for 30 days. When a file appears again at the same path with the same size and modification time, it gets its id and added date back, as when a folder was briefly unavailable.
- **Otherwise a new item.** A different file at an old path, or a file at a new path, is a new item.

## Errors

Every failure is JSON `{ "error": { "code": "...", "message": "..." } }`, with a stable `code` to branch on and a `message` for people that never contains paths or credentials. `slow_down` also carries `interval`. Every 429 carries `Retry-After`.

| Status | Codes |
| --- | --- |
| 400 | `invalid_request` |
| 401 | `authorization_required`, `token_invalid`, `token_revoked` |
| 403 | `forbidden_origin` (a web page on another site sent the request) |
| 404 | `not_found`, `item_not_found` |
| 405 | `method_not_allowed` |
| 422 | `library_too_large` |
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
