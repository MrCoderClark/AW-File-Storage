# 0001c. Uploads to R2 and public vCard addresses

Child of [0001, Secure file storage platform on Cloudflare](index.md).

## Summary

This is the reason the product exists. A signed in user drags a file into the browser, the file bytes go straight from the browser to a private Cloudflare R2 bucket without passing through our server, and then our server checks what actually arrived. If it is a valid vCard (a `.vcf` contact card), the server copies it into a separate public bucket and it becomes readable at a permanent address like `https://contacts.americaworks.com/c/jane-doe.vcf`. Everything else stays in the private bucket and can only be reached through a short lived signed link. Re-uploading a person's card replaces the file behind the same address, so a printed QR code never stops working.

**Inline rationale.** Three calls here carry the weight. First, the browser uploads directly to R2 using a signed link, because pushing bytes through the Worker would cap file size at the platform's request limit and burn compute on every megabyte. Second, the browser is only ever allowed to write into a private staging area, never into the public bucket, because whoever holds a signed link decides what lands at that key, and a signed link into a public bucket is an unvalidated publish button. The server validates the staged object and then copies it, so nothing reaches the public address that our code has not looked at. Third, public and private files live in two physically separate buckets rather than two prefixes in one, because only one of those two designs makes a private file unreachable by guessing a URL regardless of any bug we later write.

## Requirements

**User stories**:
- As a staff member, I want to drag a folder of contact cards in at once and watch each one's progress, so that a bulk update is not fifty separate operations.
- As a staff member, I want the public address of a contact card to be permanent, so that I can print it as a QR code on a business card.
- As a staff member, I want to re-upload someone's card when their phone number changes and have the same address serve the new details, so that printed cards keep working.
- As a staff member, I want a non vCard file to stay private, so that uploading the wrong document does not put it on the internet.
- As an admin, I want to unpublish a card immediately, so that a person who leaves stops being reachable through us.
- As an admin, I want a signed link to a private file that stops working shortly after, so that sharing something internally is not permanent.

**Acceptance criteria**:
- **AC-1**: An authenticated user receives a signed link that permits writing exactly one object, into the private bucket under `incoming/`, and nothing else. The link expires in 15 minutes. It cannot be used to write anywhere else, to read anything, or to delete anything.
- **AC-2**: No file bytes pass through the Worker on upload. The Worker only issues signed links and reads object metadata afterwards.
- **AC-3**: A file larger than 90 MB is uploaded in parts, each part is retried independently on failure, and an interrupted upload can be resumed rather than restarted.
- **AC-4**: A file larger than the configured cap is refused before any signed link is issued. The default cap is 5 GiB, and a vCard is separately capped at 256 KB.
- **AC-5**: Once the bytes are present, the server verifies the actual object size and sniffs its real content type. A file whose real type contradicts what the browser declared is rejected and never published.
- **AC-6**: A vCard is accepted only if it decodes as UTF-8, begins with `BEGIN:VCARD`, ends with `END:VCARD`, declares version 3.0 or 4.0, contains a formatted name, and holds exactly one card. Anything else moves to `failed` with a reason the user can read and act on.
- **AC-7**: A valid vCard is published automatically: it is copied into the public bucket, its address is recorded, and it is fetchable at `https://contacts.americaworks.com/c/<slug>.vcf` without any credential. No other file kind can ever be published, whatever the request asks for.
- **AC-8**: The public slug is derived from the contact's name, is url safe, and is globally unique. A collision appends a short random suffix rather than overwriting the existing card. Two users publishing the same name at the same moment both succeed with different addresses.
- **AC-9**: A published vCard is served with `Content-Type: text/vcard; charset=utf-8` and a `Content-Disposition` naming the file, so that opening the address on a phone offers to save the contact.
- **AC-10**: Re-uploading a card for an existing slug keeps the address unchanged, replaces the object behind it, records a new version row, and purges the cached copy so the new details are served within seconds rather than after the cache expires.
- **AC-11**: Unpublishing removes the object from the public bucket, purges the cache, clears the slug reservation, and keeps the private copy. The address then returns 404.
- **AC-12**: A private file is reachable only through a signed read link that expires in 5 minutes. The private bucket has no public domain and no public access, so guessing a key returns nothing.
- **AC-13**: Calling finalize twice for the same upload produces the same result and no second version row, no second audit row, and no duplicate object.
- **AC-14**: An upload that is started and abandoned leaves nothing permanent. Staged objects with no completed upload session are deleted after 24 hours, and incomplete multipart uploads are aborted on the same schedule.
- **AC-15**: A failed upload shows the user why it failed and offers a retry that does not require re-selecting the file, matching the `FAILED - Retry` state in the mock.
- **AC-16**: Publishing, republishing, unpublishing, deleting, and issuing a private read link each write one audit row naming the actor, the file, and the address involved.
- **AC-17**: A published vCard response carries a directive telling search engines not to index it, so that staff contact details do not accumulate in search results.

## Decision

**Chosen option**: Signed direct upload into a private staging area, then server side validation, then a copy into a separate public bucket for valid vCards only.

Two buckets, `aw-files-private` and `aw-files-public`. The public bucket alone has a custom domain. The browser can only ever write to the private one.

## Feature design

**The pipeline**

```
1. requestUpload      browser declares name, size, type
                      server checks quota and cap, creates a file row (status pending)
                      and an upload_session, returns a signed PUT link (or part links)
2. browser PUT        bytes go browser to R2 private bucket, key incoming/<uploadSessionId>
                      progress comes from the upload's own progress events
3. finalizeUpload     server HEADs the staged object, confirms size, sniffs the real type
                      status validating, then enqueues the processing job
4. queue consumer     vCard: parse and normalise, derive the slug, copy into the public
                      bucket at c/<slug>.vcf with its headers, purge the cache
                      other: copy into the private bucket at files/<orgId>/<fileId>/<name>
                      either way: delete the staged object, update usage, status ready
5. failure            status failed with a readable reason, staged object deleted,
                      quota usage untouched
```

Steps 3 and 4 are separate so that a slow validation never holds the browser open, and so a retry is a queue redelivery rather than a re-upload.

**Buckets and keys**

| Bucket | Binding | Public domain | Keys |
|---|---|---|---|
| `aw-files-private` | `FILES_PRIVATE` | none, ever | `incoming/<uploadSessionId>` for staging, `files/<orgId>/<fileId>/<originalName>` once accepted |
| `aw-files-public` | `FILES_PUBLIC` | `contacts.americaworks.com` | `c/<slug>.vcf` only. Nothing else is ever written here |

The private bucket's CORS policy allows `PUT` from the application origin only, with `Content-Type` allowed and `ETag` exposed so multipart parts can be assembled. The public bucket needs no CORS rule at all.

**Signing**: R2's S3 compatible API, signed with `aws4fetch` (a tiny signing library that works in the Workers runtime, unlike the full AWS SDK which is far too heavy for a Worker bundle). Credentials are an R2 access key pair held as Worker secrets. Every signed link is scoped to one exact key and one method, and carries the shortest expiry that works: 15 minutes to write, 5 minutes to read.

**vCard validation and normalisation** (AC-6)

| Check | Rule |
|---|---|
| Size | at most 256 KB |
| Encoding | must decode as UTF-8, with a leading byte order mark stripped |
| Envelope | starts with `BEGIN:VCARD`, ends with `END:VCARD`, exactly one of each |
| Version | `VERSION:3.0` or `VERSION:4.0` present |
| Name | an `FN` line with a non empty value, or an `N` line we can build one from |
| Line endings | normalised to carriage return plus line feed, which the vCard format requires, and a trailing line ending is added if missing |
| Folding | long lines are left as they are; unfolding is only for reading the name |
| Output | the normalised text is what gets published, not the raw upload |

**Slug rules** (AC-8): take the formatted name, lowercase it, strip accents, replace anything that is not a letter or number with a single hyphen, trim hyphens from both ends, cut to 60 characters. Empty result falls back to `contact`. The slug is unique across the whole system because it is a path on one shared public domain, so it is a globally unique column. On a collision, append a hyphen and 5 random base32 characters and retry, up to 5 times. Two simultaneous publishes both succeed because the unique constraint decides the winner and the loser retries with a suffix.

**Republish** (AC-10): a new upload whose derived slug matches an existing published card in the same organization is treated as a new version of that card, not a new card. The address does not change. A new `file_version` row records the previous object, the public object is overwritten, and the cached copy is purged through the Cloudflare cache purge API by URL. If the purge call fails, the publish still succeeds, the failure is logged, and the change becomes visible when the short cache lifetime expires.

**Public response headers** (AC-9, AC-17): set on the object when it is written, since the R2 custom domain serves object metadata directly.

| Header | Value |
|---|---|
| `Content-Type` | `text/vcard; charset=utf-8` |
| `Content-Disposition` | `attachment; filename="<slug>.vcf"` |
| `Cache-Control` | `public, max-age=300, s-maxage=300` |
| `X-Robots-Tag` | `noindex, nofollow`, added by a Cloudflare response header transform rule on the public hostname, because per object custom headers are not available |

The 5 minute cache is short on purpose: it absorbs a burst of scans of one QR code, and it bounds how long stale details are served if a purge fails.

**Interface surface**

| Surface | Kind | Inputs | Outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `requestUpload` | action | name, size, content type, optional intended slug | file id, upload session id, signed link or part links | session | 400 invalid, 413 over the cap, 409 over quota |
| `finalizeUpload` | action | upload session id, multipart parts if any | file status | session, owner of the session | 404 unknown, 410 session expired, 422 size or type mismatch |
| `getUploadStatus` | action | file ids | status, failure reason, public address | session | 403 |
| `publishVcard` | action | file id | public address | owner or admin, or member for own file | 409 not a vCard, 422 validation failed |
| `unpublishVcard` | action | file id | confirmation | owner or admin, or member for own file | 404 |
| `createPrivateLink` | action | file id | signed read link, expiry | session | 404, 403 |
| `deleteFile` | action | file id | confirmation | owner or admin, or member for own file | 404 |
| `listFiles` | action | filters, cursor | paged files with status and address | session | 403 |
| `GET https://contacts.americaworks.com/c/<slug>.vcf` | R2 custom domain, no Worker | none | the vCard file | none, public | 404 |

**Key invariants**:
1. The browser can never obtain a signed link that writes to the public bucket. Only the Worker writes there, and only after validation.
2. Nothing but a validated, normalised single vCard is ever written to the public bucket.
3. A public address, once issued, is never reassigned to a different person's card. Unpublishing frees the object but the slug is retired, not recycled.
4. A file's recorded size always matches the real object size, because the recorded value comes from the server's own read of the object and never from the browser's declaration.
5. Finalize is idempotent, keyed on the upload session (AC-13).
6. Quota usage is only ever increased for a file that reached `ready`, inside the same transaction that sets that status.
7. Every staged object either becomes a stored file or is deleted. There is no third outcome that survives 24 hours.

**Security model**: an upload requires a session. A signed write link is scoped to one key, one method, and 15 minutes, so a leaked link permits overwriting one staging object that is about to be validated anyway. The private bucket has no public domain, so private files are unreachable without a signed read link regardless of any application bug (AC-12). Publishing is restricted by the role matrix in child [0002](0002-tenancy-and-data-model.md): an admin or owner can publish or unpublish anything in the organization, a member only their own. Compliance scope: a published vCard is personal data made deliberately public, so publish, republish, and unpublish are all audited (AC-16), unpublish is immediate rather than eventual, and the responses are marked not to be indexed (AC-17).

**Configuration required**:
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: Worker secrets, used only to sign links.
- `R2_PRIVATE_BUCKET`, `R2_PUBLIC_BUCKET`: bucket names, also bound as `FILES_PRIVATE` and `FILES_PUBLIC`.
- `PUBLIC_FILE_DOMAIN`: `contacts.americaworks.com`.
- `MAX_UPLOAD_BYTES`: default 5368709120 (5 GiB).
- `MAX_VCARD_BYTES`: default 262144 (256 KB).
- `MULTIPART_THRESHOLD_BYTES`: default 94371840 (90 MB).
- `UPLOAD_LINK_TTL_SECONDS`: default 900. `DOWNLOAD_LINK_TTL_SECONDS`: default 300.
- `CF_API_TOKEN`, `CF_ZONE_ID`: Worker secrets, for purging a republished address from the cache.

**Critical test scenarios**:
- Happy path: a valid `.vcf` is uploaded, becomes `ready`, and its public address returns the file with the right content type to an unauthenticated request. Verifies **AC-1**, **AC-7**, **AC-9**.
- Direct transport: the upload request never reaches the Worker, confirmed by the absence of any Worker invocation carrying the file body. Verifies **AC-2**.
- Signed link scope: the link is replayed against a different key, against the public bucket, and as a `GET`, and all three are refused. Verifies **AC-1**.
- Multipart: a 150 MB file uploads in parts, one part is failed deliberately and retried, and the assembled object matches its checksum. Verifies **AC-3**.
- Caps: a file over the cap and a `.vcf` over 256 KB are both refused before any link is issued. Verifies **AC-4**.
- Lying browser: an executable declared as `text/vcard` is rejected at validation and never published. Verifies **AC-5**, **AC-6**.
- Malformed vCard: missing `END:VCARD`, a missing formatted name, version 2.1, two cards in one file, and invalid UTF-8 each land in `failed` with a distinct readable reason. Verifies **AC-6**, **AC-15**.
- Non vCard: a `.pdf` uploads successfully, is stored privately, and no request can make it public. Verifies **AC-7**, **AC-12**.
- Collision: two cards named Jane Doe published concurrently produce two different addresses and neither overwrites the other. Verifies **AC-8**.
- Republish: the same person re-uploaded keeps the address, serves the new details within seconds, and leaves a version row for the old object. Verifies **AC-10**.
- Unpublish: the address returns 404 promptly, the private copy still exists, and the slug is not handed to anyone else. Verifies **AC-11**.
- Private link: a signed read link works, and the same link 6 minutes later does not. Verifies **AC-12**.
- Idempotency: finalize called twice yields one version row, one audit row, and one object. Verifies **AC-13**.
- Abandonment: a staged object with no finalize is gone after the sweep, and an incomplete multipart upload is aborted. Verifies **AC-14**.
- Audit: publish, republish, unpublish, delete, and private link each write exactly one row naming actor, file, and address. Verifies **AC-16**.

## Build plan

Thin end to end slices (the assumed default). Step 2 deliberately gets one real vCard to one real public address before anything else is built out, because that single thread is the product.

1. Wrangler configuration for both R2 buckets, the private bucket's CORS rule, the public bucket's custom domain on `contacts.americaworks.com`, and the response header transform rule. Satisfies the platform half of **AC-7**, **AC-12**, **AC-17**.
2. Thin end to end slice: `requestUpload` issuing a single `PUT` link, a browser upload, `finalizeUpload` reading the object, minimal vCard validation, a copy into the public bucket, and a fetch of the resulting public address. Satisfies **AC-1**, **AC-2**, **AC-7**, **AC-9**.
3. Full vCard validator and normaliser with a reason for each rejection, plus its unit tests over a fixture set of good and bad cards. Satisfies **AC-6**, **AC-15**.
4. Slug derivation, the global unique constraint, and the collision retry. Satisfies **AC-8**.
5. Real content type sniffing and server side size confirmation at finalize. Satisfies **AC-5**.
6. Caps and the quota check, both before any link is issued. Satisfies **AC-4**, and **AC-9** of child 0002.
7. Move validation onto a Cloudflare Queue, with the finalize action only enqueueing, and make finalize idempotent on the upload session. Satisfies **AC-13**.
8. Multipart uploads above the threshold: part links, per part retry, resume, and assembly. Satisfies **AC-3**.
9. Private file storage path and `createPrivateLink` with its 5 minute expiry. Satisfies **AC-12**.
10. Republish as a new version: version rows, object overwrite, and cache purge with a logged failure path. Satisfies **AC-10**.
11. `unpublishVcard`: remove the object, purge, retire the slug, keep the private copy. Satisfies **AC-11**.
12. The Cron Trigger sweep: expired upload sessions, orphaned staged objects, aborted multipart uploads, and soft deleted file objects. Satisfies **AC-14**.
13. Audit writes on every action in the table. Satisfies **AC-16**.
14. The test suite from Critical test scenarios, in Vitest against real R2 and D1 bindings plus a Playwright run of a real browser upload. Covers every acceptance criterion above.
