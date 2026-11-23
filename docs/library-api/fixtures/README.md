# Fixtures

Invented example responses of the [library API](../openapi.yaml). Every name, code and token here is made up. A test checks each against the contract.

| File | Response |
| --- | --- |
| `pair-start.json` | `POST /pair/start` |
| `pair-poll-approved.json` | `POST /pair/poll`, approved |
| `me.json` | `GET /me` |
| `library-response.json` | `GET /library` |
| `library-data.json` | An example `library.json` data file, served as is by `GET /library/data` |
| `error-slow-down.json` | `POST /pair/poll` polled too early |
