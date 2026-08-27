# AW File Storage

Internal file storage for America Works. Staff sign in, upload files into private storage, and contact cards (`.vcf`) are published automatically to a stable public address on **contacts.americaworks.com** — the kind of address you can print behind a QR code on a business card and never have to change.

> **Status: specifications complete, no application code yet.** This repository currently holds the design specs and this README. The build has not started.

## How it works

```
Browser ──PUT (presigned)──▶  R2 private bucket (staging)
   │                               │
   │  sign in / actions            │  Worker validates the bytes
   ▼                               ▼
Cloudflare Worker  ◀── D1 (Postgres-like SQLite) records
(Next.js app + API)                │
   │                               │  valid vCard? copy it →
   ▼                               ▼
Better Auth (login)         R2 public bucket ──▶ contacts.americaworks.com/c/<name>.vcf
```

Everything runs on **Cloudflare**, in one account:

- **Cloudflare Worker** — the Next.js app and its API (the "contact-management application" in the original plan).
- **Cloudflare R2** — the file storage, in two buckets: one **private** (everything by default) and one **public** (published vCards only).
- **Cloudflare D1** — the database (users, organizations, file records, audit log).
- **contacts.americaworks.com** — a public custom domain on the public R2 bucket, serving published contact cards with no login and no server compute.

> **Why not host the app "on R2"?** R2 is object storage — a bucket of files. It has no compute, so it cannot run a login, sign a private download link, or render a page. The app therefore runs on a **Worker**, with R2 attached to it as storage. This is the correct Cloudflare shape and what the specs are built around.

## Stack

Next.js 15 (App Router, React 19) on Cloudflare Workers · Drizzle ORM on D1 · **Better Auth** (self hosted) for login · two R2 buckets · Tailwind CSS v4 + shadcn/ui · Zod · Vitest + Playwright. Full detail and the reasoning are in the specs.

## Security posture (the short version)

- **Login is Better Auth**, self hosted in our Worker — proven, audited primitives (scrypt hashing, session revocation, CSRF/origin checks, rate limiting), with every user row still in our own D1 and no per user fee. It is configured the secure way and hardened further (12 char minimum, breach check, per account lockout, required two factor for admins). See [spec 0001](docs/specs/0001-secure-file-storage-platform/0001-authentication-and-sessions.md).
- **Organization isolation** is enforced by a scoped database wrapper, not by remembering to filter. A query cannot reach another organization's rows. See [spec 0002](docs/specs/0001-secure-file-storage-platform/0002-tenancy-and-data-model.md).
- **Private by default.** Only validated `.vcf` cards ever reach the public bucket; the private bucket has no public domain, so a private file cannot be reached by guessing a URL. See [spec 0003](docs/specs/0001-secure-file-storage-platform/0003-uploads-and-public-vcard-urls.md).
- **Every state changing action is audited**, because the files hold third party personal data.

## Getting started (once the scaffold exists)

```bash
npm install
cp .dev.vars.example .dev.vars          # fill in the secrets below
npx wrangler d1 migrations apply aw-file-storage --local
npm run dev
```

Required secrets (Worker secrets in production via `wrangler secret put`, `.dev.vars` locally): `BETTER_AUTH_SECRET`, `APP_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, and the R2 / Cloudflare API keys. The full list is in [AGENTS.md](AGENTS.md).

## Documentation

- [AGENTS.md](AGENTS.md) — the stack, commands, and conventions for anyone (human or AI) working in the repo.
- [docs/specs/0001-secure-file-storage-platform/](docs/specs/0001-secure-file-storage-platform/index.md) — the full specifications:
  - [Stack & cross-cutting contract](docs/specs/0001-secure-file-storage-platform/index.md)
  - [Authentication (Better Auth)](docs/specs/0001-secure-file-storage-platform/0001-authentication-and-sessions.md)
  - [Tenancy & data model](docs/specs/0001-secure-file-storage-platform/0002-tenancy-and-data-model.md)
  - [Uploads & public vCard URLs](docs/specs/0001-secure-file-storage-platform/0003-uploads-and-public-vcard-urls.md)
  - [Upload Center UI](docs/specs/0001-secure-file-storage-platform/0004-upload-center-ui.md)

## Decisions still open before launch

- **Product name** — the mock says "OmniDrive Enterprise" (placeholder). Header reads from `NEXT_PUBLIC_APP_NAME`.
- **Storage quota per organization** — the mock shows 5 TB (placeholder). Pick a real number.
- **Max file size** — the mock says "up to 10 GB"; the spec defaults the cap to 5 GiB. Confirm the real limit.
- Not in this release, each its own future spec: QR code image generation for a published card, virus scanning on upload, file versioning beyond the vCard republish case, and external tenant SSO.
