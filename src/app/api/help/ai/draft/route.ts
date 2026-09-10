import { getCloudflareContext } from "@opennextjs/cloudflare";
import { generateDraft, type WorkersAi } from "@/server/help-ai";
import { orgDbFor } from "@/server/org-db";
import { requireApiRole } from "@/server/session";

// AI-assisted help-article draft (spec 0027). Admin/owner only, org-scoped. Runs Cloudflare
// Workers AI over the topic plus the caller's own + shared published articles as context (the
// reader union — no new cross-org read), returns a sanitized draft, and records one audit event.
// Stateless: nothing is saved until the admin saves the article through the normal editor.
export const dynamic = "force-dynamic";

interface Env {
  DB: D1Database;
  AI: WorkersAi;
}

const MAX_TOPIC = 300;
const MAX_INSTRUCTIONS = 1000;
// Per-user throttle: at most this many generations per hour (counted from the audit trail).
const RATE_PER_HOUR = 20;
const AI_DRAFT_ACTION = "help.ai_draft";

export async function POST(req: Request) {
  const auth = await requireApiRole("admin");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as {
    topic?: string;
    instructions?: string;
  };
  const topic = (body.topic ?? "").trim();
  const instructions = (body.instructions ?? "").trim().slice(0, MAX_INSTRUCTIONS);
  if (!topic) {
    return Response.json(
      { ok: false, error: "Enter a topic to generate a draft." },
      { status: 400 },
    );
  }
  if (topic.length > MAX_TOPIC) {
    return Response.json({ ok: false, error: "Topic is too long." }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  const e = env as unknown as Env;
  const scoped = orgDbFor(auth.actor.orgId, e.DB);

  // Rate limit from the audit trail (no extra table).
  const recent = await scoped.audit.countByActorAction(
    auth.actor.userId,
    AI_DRAFT_ACTION,
    Date.now() - 60 * 60 * 1000,
  );
  if (recent >= RATE_PER_HOUR) {
    return Response.json(
      { ok: false, error: "You've generated a lot of drafts. Try again in a little while." },
      { status: 429 },
    );
  }

  // Reference context: this org's own + shared published articles (the reader union).
  const articles = await scoped.help.listForReader({ viewerIsAdmin: true });

  let draft: Awaited<ReturnType<typeof generateDraft>>;
  try {
    draft = await generateDraft(e.AI, { topic, instructions }, articles);
  } catch (err) {
    // Log the underlying cause server-side (visible in the dev terminal / Worker
    // logs). The most common local-dev failure is the Workers AI binding being
    // unreachable: Workers AI has no local emulator, so `next dev` must proxy to
    // real Workers AI (needs remote bindings + a Cloudflare login). The client
    // still gets a generic message — we never leak internals to the browser.
    console.error("help.ai_draft generation failed:", err);
    return Response.json(
      { ok: false, error: "Couldn't generate a draft right now. Please try again." },
      { status: 502 },
    );
  }

  // Record usage (topic only, never the generated body).
  await scoped.audit.append({
    actorUserId: auth.actor.userId,
    action: AI_DRAFT_ACTION,
    targetType: "help_article",
    metadataJson: JSON.stringify({ topic: topic.slice(0, MAX_TOPIC) }),
  });

  return Response.json({ ok: true, ...draft });
}
