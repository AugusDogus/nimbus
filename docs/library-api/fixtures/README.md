# Fixtures

Invented example responses of the [library API](../openapi.yaml). Every name, code and token here is made up. A test checks each against the contract.

| File | Response |
| --- | --- |
| `pair-start.json` | `POST /pair/start` |
| `pair-poll-approved.json` | `POST /pair/poll`, approved |
| `me.json` | `GET /me` |
| `library-response.json` | `GET /library` |
| `item.json` | `GET /items/{id}` |
| `media-address.json` | `POST /items/{id}/stream` (it also sets a cookie) |
| `error-slow-down.json` | `POST /pair/poll` polled too early |
