# 0006. Create Card: build a vCard from a form

**Date**: 2026-08-29

## Summary

Today the only way to publish a contact card is to already have a `.vcf` file and drop it on the Upload Center. Staff mostly do not have one — they have the person's details. This spec adds a **Create Card** form: enter name, email, phone(s), org, title, address, and website, and the app builds a valid vCard 3.0 in the browser and pushes it through the *existing* upload → validate → publish pipeline, so it lands at the same public `contacts.awvcard.com` URL as an uploaded file. It is a TypeScript port of the engineer's Python generator (`docs/Designs/vcf Generator.py`), minus the Excel/photo parts.

**Inline rationale.** The publish pipeline (spec 0003) already validates, normalises, dedupes, and publishes vCards and returns the public URL. So the form's only new job is to produce a well-formed `.vcf` string and hand it to that pipeline — no new server endpoints, no second publish path. Building the vCard client-side keeps it a pure function that is trivially testable and reuses the drag-drop upload queue as-is.

## Requirements

**User stories**:
- As a staff member, I want to type someone's details and get a published contact card, so that I don't have to hand-write a `.vcf`.
- As a staff member, I want the phone numbers formatted consistently (E.164-ish, `1` + 10 digits), so that phones dial them correctly from the card.

**Acceptance criteria**:
- **AC-1**: A **"Create Card"** tab in the primary navigation, next to Upload Center, opens a page with the form. (Placement chosen as a dedicated tab rather than a toggle on the Upload Center.)
- **AC-2**: The form requires First name, Last name, and Email. Everything else (Full name, Mobile, Work phone, Fax, Organization, Job title, Address/City/State/Zip/Country, Website) is optional. Full name defaults to "First Last" when left blank.
- **AC-3**: Submitting builds a vCard **3.0** matching the Python generator's field layout: `N:Last;First;;;`, `FN`, `EMAIL;TYPE=WORK`, `TEL;TYPE=CELL,VOICE`, `TEL;TYPE=WORK,VOICE`, `TEL;TYPE=WORK,FAX`, `ORG`, `TITLE`, `ADR;TYPE=WORK:;;street;city;state;zip;country`, `URL;TYPE=WORK`. Only non-empty fields emit a line.
- **AC-4**: Phone numbers are normalised exactly as the Python does: strip non-digits; 10 digits → `1##########`; 11 digits starting `1` → as-is; anything else → the line is omitted (a work phone that fails parsing but is non-empty is kept verbatim, matching the script). An `x`/`ext` suffix becomes `,,<ext>`.
- **AC-5**: The generated card is published through the **existing** upload API (`POST /api/uploads` → PUT to R2 → `POST /api/uploads/finalize`) as a file named `First_Last.vcf`, so it validates, dedupes, and publishes through spec 0003 with no new server code. On success the page shows the resulting public URL with a copy control; on rejection it shows the pipeline's reason.
- **AC-6**: vCard special characters in field values are escaped per RFC 6350 (`\`, `;`, `,`, newlines) so a name like "Smith, Jr." cannot break the structure.
- **AC-7**: The form has a designed error state (a failed publish shows the reason from the pipeline, e.g. duplicate card 409) and resets cleanly after a successful publish.
- **AC-8**: Every field is keyboard reachable with visible focus; required fields are marked; the form is usable at 360px.

## Decision

**Chosen option**: A client-side vCard builder (`src/lib/vcard-builder.ts`) plus a form that reuses the Upload Center's upload queue. **No new endpoints.** Photo support and Excel/bulk import are **out of scope** (deferred): photos bloat a card whose URL is barcoded, and bulk import is a separate concern.

**Implementation skills**: `tailwindcss-v4` · `frontend-design`.

## Feature design

**`src/lib/vcard-builder.ts`** (pure, unit-tested):
- `parsePhone(input: string): string | null` — the port of `parse_phone_number`.
- `escapeVcard(value: string): string` — RFC 6350 escaping.
- `buildVcard(fields: CardFields): string` — assembles the card; emits only non-empty lines; CRLF line endings. Output passes `validateVcard` (VERSION:3.0, single-line fields, FN present).
- `CardFields` type: firstName, lastName, fullName?, email, mobilePhone?, workPhone?, fax?, organization?, jobTitle?, street?, city?, state?, zip?, country?, website?.

**UI**: a `Create Card` nav tab → `/create-card` page rendering `<CreateCardForm>`. On submit, the form calls `buildVcard`, wraps the string in a `File([...], "First_Last.vcf", { type: "text/vcard" })`, and runs the three-step upload API itself (`/api/uploads` → PUT → `/api/uploads/finalize`), then shows the published URL with a copy control and calls `useAppData().refresh()` so the rail + file list update (AC-10 of 0004).

**Key invariants**:
1. The form never publishes directly; it only produces a `File` and enqueues it. The server remains the single publish authority (spec 0003).
2. `buildVcard` output always validates or the pipeline rejects it with a readable reason — the form shows that reason rather than inventing its own.

**Critical test scenarios**:
- `parsePhone`: 10 digits, 11 with leading 1, 7 digits (→ null), with `x123` extension.
- `buildVcard`: minimal (name+email) and full; special characters escaped; passes `validateVcard`.
- Happy path: fill the form, submit, the card publishes and shows a `contacts.awvcard.com` URL.

## Build plan

1. `src/lib/vcard-builder.ts` + Vitest unit tests (`parsePhone`, `buildVcard`, escaping, validates against `validateVcard`).
2. `CreateCardForm` component (fields, validation, a11y).
3. Wire the Upload Center toggle and the build → enqueue path.
4. Verify end to end: form → published public URL.

## Follow-up — edit a published card in place (2026-09-01, PR #26)

Create-only left no way to fix a published card's details short of delete + re-create (which mints a new URL). Editing reuses this same form.

- **Entry point:** an **Edit card** action on published vCard rows → `/files/[id]/edit` (RSC), which loads the stored `.vcf` via `getCardForSignature`, maps it back to form fields with `cardFieldsFromParsed` (`vcard-builder.ts`), and renders `CreateCardForm` in **edit mode** (`initial` + `editFileId` props; button = "Save changes").
- **Server:** `editVcard(env, ctx, fileId, vcardText, newName?)` in `uploads.ts` — re-validates the rebuilt card, overwrites **both** the durable private copy and the public object **at the existing `public_slug`**, refreshes the denormalised `contact_*` search fields, adjusts org storage usage by the size delta, rejects a checksum collision with a *different* live card, and audits `vcard.edited`. `PATCH /api/files/[id]/card`; `canManage` re-checked.
- **Key invariant — the URL is stable:** an edit never re-derives the slug, so the public `contacts.awvcard.com/c/<slug>.vcf` address (and any printed QR / shared link) keeps resolving. Consequence: the slug can drift from a renamed contact over time; a fresh URL still requires delete + re-create.
- **No DB migration** (reuses the Phase-10 `contact_*` columns). Tests: `test/vcard-builder.test.ts` proves the `parse → cardFieldsFromParsed → buildVcard → parse` round trip is stable (phones, org, address survive).

### Constrained fields (2026-09-01, PR #28)

Two fields were locked down to keep cards consistent:
- **Organization** is a **dropdown** of the AW regional entities (`ORG_OPTIONS` in `create-card-form.tsx`) rather than free text. Editing an older card whose org isn't in the list keeps that value as an extra option (never silently dropped); a blank entry keeps it optional.
- **Website** is **read-only**, fixed to `https://www.americaworks.com` (`FIXED_WEBSITE`), forced in both create and edit — so editing an existing card also normalises its URL to this value on save.
- **State** is a **dropdown** (`US_STATE_OPTIONS`) storing the canonical 2-letter abbreviation; an edited card's state is normalised on load so it matches an option. City stays free text (no finite list). This also feeds the per-state signature features (logos/socials) cleaner data.
