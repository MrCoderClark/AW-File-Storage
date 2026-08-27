# 0001b. Tenancy, roles, and the data model

Child of [0001, Secure file storage platform on Cloudflare](index.md).

## Summary

Every user belongs to an organization, and every row of data belongs to one too. The organizations, the three roles inside them, and the invitations are provided by Better Auth's `organization` plugin (child [0001](0001-authentication-and-sessions.md)); this spec owns everything built on top of them — the file, version, upload, and audit tables, the storage quota shown in the mock, and the one mechanism that guarantees a query can never reach another organization's rows by accident. It is built first, because adding organization ownership to a database after launch means touching every query, every index, and every access check in the codebase.

**Inline rationale.** Organization isolation is the only decision in this whole project that cannot be retrofitted cheaply, so it goes in the first migration even though fewer than a hundred users are expected. Isolation is enforced by a wrapped database client rather than by discipline, because "remember to filter by organization" is a rule that holds until the first tired Friday afternoon. Cloudflare D1 has no row level security, so the enforcement has to live in the application layer, and the safest application layer enforcement is one that makes the unsafe query impossible to write rather than merely discouraged. Using Better Auth's `organization` plugin for the organizations, roles, and invitations themselves means the identity side of tenancy is proven library code, and the `activeOrganizationId` it stores on the session is the source of truth for which organization a request is acting in; this spec's job is to make every *tenant data* query honour that. Separate databases per organization were rejected: they are the right answer only for enterprise customers with a contractual data isolation requirement, and they would multiply the operational cost of every migration for an internal tool.

## Requirements

**User stories**:
- As an owner, I want my organization's files and members to be invisible to every other organization, so that isolation is a property of the system and not of someone remembering to check.
- As an owner, I want three clear roles, so that a member cannot delete what an admin can.
- As an admin, I want to see how much of our storage allowance we have used, so that I know before we run out.
- As an owner, I want a permanent record of every action taken on our data, so that I can answer a question about it a year from now.

**Acceptance criteria**:
- **AC-1**: Every table that holds tenant data carries a non null `org_id`, and every one has an index that leads with `org_id`.
- **AC-2**: Feature code reaches tenant data only through an organization scoped database client. Attempting to read or write a tenant table without an organization in scope throws at runtime rather than returning rows.
- **AC-3**: A user acting in organization A receives 404 for a file, member, or audit row in organization B. The response never distinguishes "does not exist" from "exists but is not yours".
- **AC-4**: The role permission matrix below is enforced in one shared place. A member calling an admin only action receives 403 and the action has no effect.
- **AC-5**: An organization always has at least one owner. Removing or demoting the last owner is rejected.
- **AC-6**: A user may belong to more than one organization. Their session records which one they are acting in, and switching organizations re-reads their role rather than trusting anything the browser sent.
- **AC-7**: Deleting a file is a soft delete: the row is marked deleted, keeps its `deleted_at` and `deleted_by`, and stops appearing in every listing. Storage is reclaimed by a scheduled job, not by the request.
- **AC-8**: An audit row, once written, is never updated or deleted by application code. There is no code path that edits one.
- **AC-9**: An upload that would take the organization past its storage quota is refused before any file bytes are accepted, and the message states the quota and the current usage.
- **AC-10**: Stored usage totals match the sum of the organization's live file sizes. A reconciliation job runs nightly and logs any drift it corrects.
- **AC-11**: Every identifier is a sortable, unguessable, url safe string. No integer that increments, so nothing can be enumerated or counted from the outside.
- **AC-12**: Every migration is a checked in SQL file applied by `wrangler d1 migrations apply`, and applying them to an empty database reproduces the schema exactly.

## Decision

**Chosen option**: One shared D1 database, with an `org_id` column on every tenant table, isolation enforced by a Drizzle query wrapper that injects and requires the organization on every tenant query.

Three roles, `owner`, `admin`, and `member`, held on Better Auth's `member` row (organization plugin) rather than on the user, so one person can belong to several organizations with different roles. The organizations, memberships, and invitations are the plugin's tables; the tenant data tables below are this app's.

## Feature design

**Role permission matrix**

| Capability | owner | admin | member |
|---|---|---|---|
| Upload a file | yes | yes | yes |
| See own uploads | yes | yes | yes |
| See all organization files | yes | yes | yes |
| Delete own file | yes | yes | yes |
| Delete anyone's file | yes | yes | no |
| Publish or unpublish a vCard | yes | yes | own only |
| Invite a member | yes | yes | no |
| Change a member's role | yes | yes, except to or from owner | no |
| Remove a member | yes | yes, except an owner | no |
| End another user's session | yes | yes | no |
| Read the audit log | yes | yes | no |
| Change the storage quota | no, platform level only | no | no |
| Delete the organization | yes | no | no |

**Data model**. Cloudflare D1 is SQLite, so there are no native enum types (enums are text columns with a check constraint) and no `JSONB` (structured extras are text holding JSON). Timestamps are stored as integers of milliseconds and exposed as `Date` through Drizzle. Identifiers on this app's own tables are UUID version 7 as text: sortable by creation time, unguessable, and url safe (AC-11); Better Auth's tables keep the identifier shape its schema generates, which is likewise a non enumerable string.

*Better Auth owns these (do not redefine them — they are generated by its CLI, see child [0001](0001-authentication-and-sessions.md)):*

| Table | Owner | This app's dependency on it |
|---|---|---|
| `user` | core | `email` unique lowercased, `emailVerified`, `name`, `twoFactorEnabled`. Not tenant scoped: a user can span organizations |
| `session` | core | carries `activeOrganizationId` — the source of truth for which organization a request acts in |
| `account`, `verification`, `twoFactor` | core / plugins | credentials, email/reset tokens, second factor secret |
| `organization` | organization plugin | extended with the storage fields below via the plugin's `additionalFields`, so there is no separate organization table to keep in sync |
| `member` | organization plugin | holds the role (`owner` / `admin` / `member`). This is the sole source of truth for a role; it replaces the hand written `membership` table |
| `invitation` | organization plugin | single use, expiring organization invitations |

*The `organization` table is extended (via `additionalFields`) with:* `storage_quota_bytes` (default 5497558138880), `storage_used_bytes` (default 0), `public_domain` (default `contacts.americaworks.com`).

*This app owns these tenant tables. Every one carries a non null `org_id` referencing `organization.id`:*

| Table | Fields | Constraints and indexes |
|---|---|---|
| `file` | `id` pk, `org_id` fk, `uploaded_by` fk → `user`, `original_name`, `content_type`, `size_bytes`, `checksum_sha256`, `storage_key`, `bucket` in (`private`, `public`), `visibility` in (`private`, `public`), `kind` in (`vcard`, `other`), `status` in (`pending`, `uploading`, `validating`, `ready`, `failed`), `failure_reason` null, `public_slug` null unique, `published_at` null, `deleted_at` null, `deleted_by` null, `created_at`, `updated_at` | index on (`org_id`, `deleted_at`, `created_at`), index on (`org_id`, `kind`), unique on `public_slug` globally, unique on (`org_id`, `checksum_sha256`) where not deleted |
| `file_version` | `id` pk, `org_id` fk, `file_id` fk, `version` integer, `size_bytes`, `checksum_sha256`, `storage_key`, `uploaded_by` fk, `created_at` | unique on (`file_id`, `version`), index on (`org_id`, `file_id`) |
| `upload_session` | `id` pk, `org_id` fk, `user_id` fk, `file_id` fk, `staging_key`, `declared_size_bytes`, `declared_content_type`, `multipart_upload_id` null, `expires_at`, `completed_at` null, `created_at` | index on (`org_id`, `expires_at`), one hour life |
| `audit_event` | `id` pk, `org_id` fk, `actor_user_id` fk null → `user`, `action`, `target_type`, `target_id` null, `ip` null, `user_agent` null, `metadata_json` null, `created_at` | index on (`org_id`, `created_at`), index on (`org_id`, `target_type`, `target_id`). Insert only |
| `account_lock` | `user_id` pk, `failed_count`, `locked_until` null, `lock_level` | Drives the per account lockout in child 0001 (AC-7) |

**Relationships**: `organization` has many `member` and `invitation` (Better Auth), and many `file`, `file_version`, `upload_session`, `audit_event` (this app). `user` has many `member` rows across organizations. `file` has many `file_version` and belongs to one `organization`. Deleting an organization cascades to its members, invitations, files, versions, upload sessions, and audit events. Deleting a user does not cascade to files: `file.uploaded_by` is kept so history survives a departure, and the account is disabled rather than removed.

**File state machine**: `pending` (record created, nothing uploaded) → `uploading` (signed link issued) → `validating` (bytes present, server checking) → `ready`. From `validating` or `uploading`, a failure moves to `failed` with a reason. A `ready` file may be soft deleted at any time. A `ready` vCard may move between `visibility` values; no other kind may become `public`. The transitions themselves belong to child [0003](0003-uploads-and-public-vcard-urls.md).

**Isolation mechanism** (AC-2, the load bearing part of this spec)

```
src/server/db.ts        buildDb(env)          one Drizzle client per request from the D1 binding
src/server/org-db.ts    orgDb(orgId)          a wrapper over the Drizzle client that, for the
                                                tenant tables (file, file_version, upload_session,
                                                audit_event):
                                                - injects orgId into every read (eq(table.orgId, ...))
                                                - injects orgId into every insert
                                                - throws OrgScopeError if orgId is missing or empty
src/server/repos/*.ts                          the only modules allowed to call orgDb
```

`orgDb` exposes only per table query helpers, never the raw Drizzle client, so a tenant table cannot be queried without an organization: the unsafe query is not merely discouraged, it cannot be written through this surface. Feature code calls a repository, a repository calls `orgDb(orgId)`. The only code allowed to touch the raw `buildDb(env)` client is Better Auth (through its Drizzle adapter, which manages the identity tables) and the `src/server/repos/` and `src/server/auth/` modules. A test asserts that no other file imports `db.ts` directly. `activeOrganizationId` on the Better Auth session is where `orgId` comes from; it is never read from a form field or anything the browser supplied.

**Interface surface**

Organization membership operations are Better Auth `organization` plugin calls; this app wraps them only to add the audit write and the last owner guard. Storage and audit reads are this app's own.

| Surface | Kind | Inputs | Outputs | Auth | Key errors |
|---|---|---|---|---|---|
| set active organization | Better Auth `organization.setActive` | organization id | `activeOrganizationId` updated on the session, role re-read from `member` | session, must be a member | 403 not a member |
| list members | Better Auth `organization.listMembers` | none | members with roles | session | 403 |
| `changeMemberRole` | action wrapping `organization.updateMemberRole` | user id, role | member role updated, audited | owner, or admin outside the owner role | 403, 409 last owner |
| `removeMember` | action wrapping `organization.removeMember` | user id | member removed, audited | owner, or admin for a non owner | 403, 409 last owner |
| `getStorageUsage` | action | none | used bytes, quota bytes, percentage | session | 403 |
| `listAuditEvents` | action | filters, cursor | paged audit rows | owner or admin | 403 |

**Key invariants**:
1. A tenant table is never read or written without an organization in scope. The extension makes the unsafe query throw rather than return the wrong rows.
2. The Better Auth `member` table is the only source of truth for a role. A role is never read from a cookie, a form field, or a client supplied value, and the acting organization comes from `session.activeOrganizationId`, never from the request body.
3. An organization always has at least one owner (AC-5).
4. An audit row is insert only. There is no update or delete path in application code (AC-8).
5. `organization.storage_used_bytes` changes only inside the same transaction that changes a file's live size, and the nightly job is a check on that, not the mechanism.
6. A file is never hard deleted by a request. Soft delete now, object removal by the scheduled sweep later (AC-7).

**Security model**: isolation is enforced in the application layer because D1 offers no row level security. Access is checked twice by design: the scoped client cannot see another organization's rows, and `requireOrgRole()` from child 0001 gates the capability separately. A missing resource and a resource in another organization both return 404, so the API cannot be used to discover what exists elsewhere (AC-3). Compliance scope: the files this schema tracks contain third party personal data, so the audit log is a requirement rather than a nicety, and the actor, address, and user agent on every row exist so that an access question can actually be answered.

**Configuration required**:
- `DEFAULT_STORAGE_QUOTA_BYTES`: defaults to 5 TB, matching the mock. This is a placeholder until a real number is chosen.
- `PUBLIC_FILE_DOMAIN`: defaults to `contacts.americaworks.com`.

**Critical test scenarios**:
- Isolation: a repository call with organization A's identifier returns none of organization B's ten files, and the same call with no organization throws `OrgScopeError`. Verifies **AC-1**, **AC-2**.
- Cross organization read: fetching a real file identifier from another organization returns 404, not 403 and not the file. Verifies **AC-3**.
- Roles: a member attempting each admin only capability in the matrix receives 403 and the data is unchanged. Verifies **AC-4**.
- Last owner: demoting or removing the only owner is rejected with 409 while a second owner exists makes it succeed. Verifies **AC-5**.
- Organization switch: a user in two organizations sees only the current one's files, and switching re-reads the role from the `member` table (via `session.activeOrganizationId`) rather than from the request. Verifies **AC-6**.
- Soft delete: a deleted file leaves every listing, keeps `deleted_at` and `deleted_by`, and its stored object still exists until the sweep runs. Verifies **AC-7**.
- Audit immutability: no update or delete against `audit_event` exists anywhere in the codebase, asserted by a test that scans for it. Verifies **AC-8**.
- Quota: an upload declaring a size that would exceed the quota is refused before any signed link is issued, and the message names both numbers. Verifies **AC-9**.
- Reconciliation: usage deliberately set wrong is corrected by the nightly job and the correction is logged. Verifies **AC-10**.
- Migration: applying every migration file to an empty D1 database produces a schema matching the Drizzle schema (and the Better Auth generated tables) with no drift. Verifies **AC-12**.

## Build plan

Thin end to end slices (the assumed default). The schema and the isolation mechanism come first because every other child spec sits on them.

1. Drizzle schema for every tenant table above, plus the Better Auth generated tables (from its CLI) and the `organization` `additionalFields` for the storage columns, folded into one first migration generated by `drizzle-kit generate` and applied with `wrangler d1 migrations apply`. Satisfies **AC-1**, **AC-11**, **AC-12**.
2. `src/server/db.ts`, the per request Drizzle on D1 client from the Worker binding, shared with Better Auth's adapter.
3. `src/server/org-db.ts`, the scoping wrapper: inject `org_id` on read, inject on insert, throw when the organization is missing, and expose no raw client. Plus the test that no module outside the repositories and the auth module imports `db.ts`. Satisfies **AC-2**.
4. Repository modules for file, file version, upload session, and audit, each taking the organization first, and the shared `notFound()` helper that makes a foreign row indistinguishable from a missing one. (Organization and member reads go through Better Auth's organization plugin.) Satisfies **AC-3**.
5. `requireOrgRole()` and the permission matrix in one shared module, wired into every action. Satisfies **AC-4**.
6. The audit helper, insert only, used by every state changing action. Satisfies **AC-8**.
7. Member management: list, change role, remove, with the last owner guard. Satisfies **AC-5**.
8. Organization switching, storing the acting organization on the session and re-reading the role. Satisfies **AC-6**.
9. Soft delete on files, the listing filters that honour it, and the scheduled object sweep. Satisfies **AC-7**.
10. Quota accounting: the transactional usage update, the pre upload check, and `getStorageUsage`. Satisfies **AC-9**.
11. The nightly reconciliation Cron Trigger with its drift logging. Satisfies **AC-10**.
12. Seed script creating one organization, one owner, and one member for local development.
13. The test suite from Critical test scenarios, against real D1 bindings in Vitest. Covers every acceptance criterion above.
