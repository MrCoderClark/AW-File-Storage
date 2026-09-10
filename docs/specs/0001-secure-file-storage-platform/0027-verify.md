# 0027 — Verification

**Built 2026-09-09. Verified live 2026-09-10.** AI-assisted help-article drafting with Cloudflare
Workers AI. An admin opens "Generate with AI" in the KB editor, types a topic, and a grounded draft
(title, excerpt, body) loads into the editor for review. Stateless; no migration.

**Model:** `@cf/meta/llama-3.1-8b-instruct-fast` — the plain `@cf/meta/llama-3.1-8b-instruct` was
deprecated (2026-05-30, error code 5028). Swap `HELP_AI_MODEL` to
`@cf/meta/llama-3.3-70b-instruct-fp8-fast` for higher-quality drafts.

**Output format:** the model is asked for a `TITLE:/EXCERPT:/BODY:` delimiter block, not JSON —
JSON broke on the Markdown body's literal newlines and unescaped quotes (button names), leaking the
`{…}` wrapper into the article. `parseDraftResponse` tries delimiter → JSON → positional → raw.

**App knowledge:** externalised to `src/server/knowledge/app-knowledge.json` (editable, bundled at
build — Workers have no runtime filesystem). Add a feature by adding a line to its `features` array.

## Automated checks (passing)

- `npx tsc --noEmit` — clean.
- `npx vitest run test/help-ai.test.ts` — **12 passed**, covering:
  - **AC-2/AC-5 (context selection):** `selectContextArticles` ranks by topic-word overlap, drops
    non-matches, respects the max, and falls back sensibly. Its input is always the reader union
    (own + shared) from `listForReader`, so no other org's private content can enter the prompt.
  - **AC-3 (safe output):** `markdownToHtml` converts headings, ordered/unordered lists, bold,
    inline code, fenced code, and links; raw HTML from the model is escaped to inert text and a
    disallowed link scheme is rewritten to `#`; the full `markdownToHtml → sanitizeHelpHtml`
    pipeline leaves no live `<script>` or `javascript:`.
  - **Response parsing:** `parseDraftResponse` handles clean JSON, JSON embedded in prose, and a
    no-JSON fallback (whole response becomes the body, title from the topic).

## Implementation notes / deviations from the spec

- **No `marked` dependency.** The spec proposed `marked` for Markdown→HTML. Built an in-house
  `markdownToHtml` instead (focused on the constructs Llama emits for help docs), so the feature is
  dependency-free and verifiable without an install step. Output is js-xss sanitized regardless, and
  raw HTML in the Markdown is escaped rather than trusted. Swap in `marked` later if richer Markdown
  (tables, nested lists) is needed.
- **Rate limit** reuses the audit trail: `orgDb().audit.countByActorAction(user, "help.ai_draft",
  sinceMs)` enforces a per-user hourly cap (20/h) with no extra table.
- **Binding:** `"ai": { "binding": "AI" }` added to `wrangler.jsonc`; called via
  `getCloudflareContext().env.AI.run("@cf/meta/llama-3.1-8b-instruct", …)`. Model id is a single
  constant (`HELP_AI_MODEL`) in `src/server/help-ai.ts`.

## Manual checks

- **AC-4 (Workers AI live): DONE 2026-09-10.** Confirmed working under local `next dev` + OpenNext:
  the platform proxy reaches real Workers AI, no remote-binding config needed. `/kb/articles/new` →
  "Generate with AI" → a topic → a real, app-accurate draft loads (verified the `.vcf`-upload
  publish flow). Note: do NOT enable remote bindings for the `AI` binding — it fails the remote
  connection and crashes `getCloudflareContext()` for every binding, taking down local dev.
- **AC-1 (fill + overwrite confirm):** generating into an empty editor fills title/excerpt/body;
  generating over existing content shows the "Replace with the AI draft?" confirm.
- **AC-5 (RBAC + rate limit + audit):** a member gets 403 from `POST /api/help/ai/draft`; after
  20 generations in an hour a user gets 429; each generation writes a `help.ai_draft` audit row
  (visible in Activity logs) carrying the topic, never the body.
- Human-in-the-loop: the draft is never published automatically — the admin saves/publishes.

## Out of scope (unchanged from the spec)

Rewrite/improve-selection and standalone tag/excerpt buttons; Vectorize RAG; streaming; multi-
language; image generation; storing/versioning generations.
