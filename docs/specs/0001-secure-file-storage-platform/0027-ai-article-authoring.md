# 0027. AI-assisted help-article authoring with Cloudflare Workers AI

**Date**: 2026-09-09
**Status**: Built (see [0027-verify.md](0027-verify.md)) — pending live Workers AI + in-browser confirmation

Extends [0025](0025-help-knowledge-base.md) and [0026](0026-help-media-library.md).

## Summary

Let an admin/owner draft a help article by asking an AI. In the Knowledge base editor they open a
**"Generate with AI"** panel, type a topic (and optional instructions), and Cloudflare **Workers
AI** (Llama 3.1 8B Instruct) returns a **title, excerpt, and body**, loaded straight into the
Tiptap editor for the admin to review and edit. Nothing is ever auto-published: the AI only fills
the draft; a human saves/publishes as normal. The model is grounded in **AW File Storage** through
a curated app-description prompt plus the org's own (and shared) published articles injected as
reference context, so drafts are app-specific rather than generic. The feature is **stateless**
(no new tables), admin/owner only, rate-limited, and every AI output is **sanitized with js-xss**
before it touches the editor. It stays inside the existing per-org + platform-owner-"shared"
isolation model: the only articles ever sent to the model are the caller's own plus shared ones
(the same union `listForReader` already returns).

## Context

The Knowledge base (specs 0024–0026) has a Tiptap editor at `/kb/articles/new` and `/kb/articles/
[id]`, a reader path (`/help`, the drawer), per-org articles with a platform-owner "shared" flag,
and a hardened js-xss sanitizer (`sanitizeHelpHtml`) that runs on save and again on render because
the app CSP allows inline script (spec 0020). `orgDb().help.listForReader` returns this org's
published articles plus every org's shared published ones (the one sanctioned cross-org read), and
already includes a stripped `searchText` per article (spec 0026) — useful for picking relevant
context. The app runs on Cloudflare Workers via OpenNext; Cloudflare **Workers AI** exposes an
`AI` binding (`env.AI.run(model, options)`) with no extra service to stand up.

The user wants to "ask the AI to create articles" with "knowledge of my app," starting with Llama
3. Writing good help takes time; a grounded first draft the admin then edits is a large speedup,
and Workers AI keeps it on the existing Cloudflare stack (no new vendor, no API key sprawl — the
binding authorizes itself).

## Requirements

**User stories:**
- As an admin/owner, I want to type a topic and get a full first draft (title, excerpt, body) I can
  edit, so writing a help article is faster.
- As an admin, I want the draft to be about **our** app (its real features and wording), not a
  generic article, so I spend less time correcting it.
- As an admin, I always want to review and edit before anything is published; the AI must never
  publish on its own.
- As an owner, I want AI drafting limited to admins/owners, rate-limited, and safe (no script
  injection from model output, no other org's private content used as context).

**Acceptance criteria:**
- **AC-1 (generate a draft)**: in the KB editor a **"Generate with AI"** control opens a small
  panel: a **topic** field (required) and optional **instructions** (tone, audience, length). On
  submit it calls the server, which runs Workers AI and returns a **title**, **excerpt**, and
  **body** (sanitized HTML). The client loads them into the editor fields (only into empty fields,
  or after a confirm when they would overwrite existing content). The article stays a **draft**;
  the admin edits and saves/publishes with the normal controls (spec 0026). Admin/owner only.
- **AC-2 (app-grounded)**: the model is given a curated **app-description** system prompt (what AW
  File Storage is and its main features) **plus** the most relevant existing published articles as
  reference context (title + excerpt, and a trimmed body for the closest matches), selected from
  `listForReader` by matching the topic against each article's `searchText`. Drafts reference real
  app concepts and match existing wording/structure.
- **AC-3 (safe output)**: the model is asked for Markdown; the server converts it to HTML and runs
  it through **`sanitizeHelpHtml`** before returning it, so nothing outside the sanitizer whitelist
  (no script, no disallowed tags/attributes) can reach the editor or be saved. The title/excerpt
  are returned as plain text (tags stripped).
- **AC-4 (Workers AI binding)**: uses the Cloudflare **`AI`** binding declared in `wrangler.jsonc`,
  called server-side via `getCloudflareContext().env.AI.run("@cf/meta/llama-3.1-8b-instruct", …)`.
  Model id is a single config constant so it can be swapped. No API key is stored (the binding
  authorizes itself). Works in local `next dev` under OpenNext via the platform proxy (which calls
  real Workers AI — see the local-dev note).
- **AC-5 (isolation, authz, safety, cost)**: the generate endpoint is **admin/owner** only
  (`requireApiRole("admin")`), **org-scoped**: the ONLY articles put into the prompt are the
  caller's own plus shared ones (`listForReader`), never another org's private content — no new
  cross-org read is introduced. Output is sanitized (AC-3). The endpoint is **rate-limited** per
  user (a small per-hour cap) to bound cost/abuse, and writes one **audit_event** per generation
  (who, org, topic — never the full output). Human-in-the-loop: the AI drafts, it never saves or
  publishes. Prompts contain no secrets.

## Decision

**Chosen approach**: a **stateless generate endpoint** plus an editor panel.

- **Grounding = curated blurb + retrieved articles** (not embeddings yet). A hand-written
  `APP_KNOWLEDGE` description of AW File Storage anchors the system prompt; on top of it the server
  selects the few most relevant published articles (own + shared) by scoring the topic words
  against each article's `searchText`, and includes their title + excerpt (plus a trimmed body for
  the top matches) as reference context, within a token budget. This grounds drafts with zero new
  infrastructure and improves as the KB grows. **Vectorize/embeddings RAG** is a clean later
  upgrade if keyword selection proves too coarse.
- **Model = Llama 3.1 8B Instruct** (`@cf/meta/llama-3.1-8b-instruct`) via the `AI` binding: fast
  and cheap, plenty for a review-and-edit draft. The model id is one config constant.
- **Output = Markdown → HTML → sanitize.** The model returns a small JSON object
  (`{ title, excerpt, body }`, `body` in Markdown), parsed defensively; `marked` converts the
  Markdown body to HTML, then `sanitizeHelpHtml` strips anything off-whitelist. Markdown is what
  8B models produce most reliably, and the conversion output maps exactly onto the sanitizer's
  allowed tags. Requesting raw HTML from the model was rejected (8B compliance with a tag
  whitelist is shakier, and it still needs sanitizing anyway).
- **Stateless, no schema change.** Generation is topic-in → draft-out; nothing is stored until the
  admin saves the article through the existing path. So there is **no migration** — the feature is
  purely additive code plus one `wrangler.jsonc` binding.

**Rejected**: auto-publishing or auto-saving AI output (must stay human-in-the-loop); a third-party
LLM API with a stored key (Workers AI is already on-stack and self-authorizing); Vectorize RAG in
v1 (overkill before the KB is large); rewrite-selection and separate tag/excerpt buttons in v1
(deferred to follow-up — v1 is the full-draft generator only); storing generations in a table
(stateless is enough; the audit log records usage).

**Implementation skills**: `tailwindcss-v4` and `frontend-design` (the Generate panel). A Cloudflare
Workers AI reference skill is not installed; note as a follow-up.

## Feature design

**No data model change.** Generation is stateless. Usage is recorded via the existing `audit_event`
insert-only helper (rule #4); no new table or column.

**Workers AI binding** (`wrangler.jsonc`): add
```jsonc
"ai": { "binding": "AI" }
```
Access server-side through `getCloudflareContext().env.AI`. Type the `Env` with Cloudflare's `Ai`
type. **Local dev note (AC-4):** under `next dev` + OpenNext the platform proxy connects the `AI`
binding to **real** Workers AI, so local generations run real inference and count toward usage
(unlike R2, which we drive via the S3 API — Workers AI has no equivalent local stub, and that is
acceptable here). No API key is needed in `.dev.vars`.

**Server AI layer** (`src/server/help-ai.ts`):
- `APP_KNOWLEDGE`: a curated, maintained description of AW File Storage (what it is; core features:
  private R2 upload, Create-Card vCard publishing to a public URL with QR + email signature, Files
  view, Office 365 sync, org/members/roles, the help KB). Kept short and factual.
- `buildDraftPrompt({ topic, instructions, articles })`: assembles the system prompt
  (`APP_KNOWLEDGE` + house rules: help-doc voice, use only real app concepts, Markdown body with
  `##`/`###` headings, steps as lists, no invented features) and the user prompt (the topic +
  instructions + the selected reference articles). Enforces a token/character budget on the context.
- `selectContextArticles(topic, articles)`: scores `listForReader` results by topic-word overlap
  with `searchText`/title, returns the top few (title + excerpt always; trimmed body for the top 1–2).
- `generateDraft(env, input)`: calls `env.AI.run(MODEL, { messages, max_tokens, temperature })`,
  parses the JSON object defensively (extract the first `{…}`; on failure treat the whole response
  as the Markdown body and derive a title from the topic), then title/excerpt → plain text,
  body Markdown → `marked` → `sanitizeHelpHtml`. Returns `{ title, excerpt, bodyHtml }`.

**API** (admin/owner, org-scoped): **new** `POST /api/help/ai/draft`.
- Body: `{ topic: string, instructions?: string }`. Validates topic present and length-capped.
- `requireApiRole("admin")`; per-user rate limit (a small hourly cap; reuse the abuse-resistance
  approach from spec 0022 or a lightweight D1/counter check); load context via `orgDb().help
  .listForReader({ viewerIsAdmin: true })`; call `generateDraft`; write an `audit_event`
  (`help.ai_draft`, actor + org + topic, never the body); return `{ title, excerpt, bodyHtml }`.
- Errors return a clean message; Workers AI failures degrade to a "couldn't generate, try again".

**Editor UX** (`src/components/kb/article-editor.tsx` + a new `ai-draft-panel.tsx`): a **"Generate
with AI"** button opens a modal (topic + optional instructions + Generate). On success it fills the
editor: title, excerpt, and the Tiptap body via `setContent(bodyHtml)`. If those fields already
have content, confirm before overwriting (reuse `ConfirmDialog`). The generated body flows through
the same resizable-image/code typography as any article. Marked "draft"; the admin edits and uses
the existing Save / Publish controls. A short "AI can be wrong — review before publishing" note.

**Security** (AC-3, AC-5): admin/owner enforced server-side; output sanitized with js-xss before it
leaves the server; only own + shared articles are ever sent to the model (no new cross-org read);
rate-limited per user; audit row per generation; no secrets in prompts; the model can never save or
publish. Body HTML that is later saved is sanitized again on save and render (unchanged 0024/0026
posture).

## Build plan (thin end-to-end slice first, then the UI, then hardening)

1. **Binding + server layer + endpoint**: add the `AI` binding to `wrangler.jsonc` and the `Env`
   type; write `src/server/help-ai.ts` (`APP_KNOWLEDGE`, `selectContextArticles`,
   `buildDraftPrompt`, `generateDraft` with `marked` + `sanitizeHelpHtml`); add
   `POST /api/help/ai/draft` (admin/owner, org-scoped context, audit). Add `marked` dependency.
   *(AC-1..5)*
2. **Editor panel**: the "Generate with AI" modal in the editor; fill title/excerpt/body with the
   overwrite confirm; the review note. *(AC-1, AC-3)*
3. **Safety + tests + `0027-verify.md`**: per-user rate limit; unit-test the pure pieces —
   `selectContextArticles` (picks only own+shared, ranks by relevance), the Markdown→HTML→sanitize
   pipeline (script/dangerous output is stripped), and the response parser (defensive JSON + Markdown
   fallback); RBAC (a member gets 403 from the endpoint). The live `env.AI.run` call is exercised
   manually (verify doc), not in unit tests. *(AC-3, AC-5)*

## Consequences

Admins get grounded first drafts in seconds, on the existing Cloudflare stack with no new vendor,
key, or table. Costs: Workers AI inference per generation (bounded by the rate limit; real calls in
local dev too), a new `marked` dependency, and a curated `APP_KNOWLEDGE` blurb to keep roughly
current as the app grows. All additive and inside the existing isolation model — the prompt context
is exactly the reader union, so no new data-exposure surface.

## Out of scope (later)

Rewrite/improve-selection and standalone "suggest tags/excerpt" buttons; Vectorize/embeddings RAG;
streaming the draft token-by-token into the editor; multi-language drafting; image generation;
storing/versioning generations; auto-suggesting related articles or category via AI; fine-tuning.

## Follow-up

- Confirm `env.AI.run` behaves under `next dev` + OpenNext (platform proxy to real Workers AI) and
  note any wrangler config needed.
- Decide the rate-limit numbers after seeing real usage and Workers AI pricing.
- Keep `APP_KNOWLEDGE` current; consider moving it to an owner-editable Settings field later.
- Consider a Cloudflare Workers AI reference skill and record it in `AGENTS.md`.
- If keyword context selection proves too coarse, revisit Vectorize RAG.
