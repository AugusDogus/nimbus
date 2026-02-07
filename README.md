# Nimbus

Your files. Your server. No compromise.

Nimbus is a self-hosted file storage and sharing platform. Deploy it on your own hardware, keep full ownership of your data, and get a fast, modern interface for managing files.

## Current features

- Live file updates with Bun watcher events.
- Folder navigation with breadcrumbs and list/grid views.
- User preferences for sorting and view mode.
- Email/password auth with Better Auth.

## Getting started

1) Install dependencies:

```bash
bun install
```

2) Copy the example env file:

```bash
cp apps/web/.env.example apps/web/.env
```

3) Run the dev server:

```bash
bun dev
```

Open http://localhost:3000.

## Tests

```bash
bun test
```
