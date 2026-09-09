import { getCloudflareContext } from "@opennextjs/cloudflare";
import { sendEmail, supportRequestEmail } from "@/server/email";
import { getActor, getSession } from "@/server/session";

// Contact-support form submit (spec 0025 follow-up). Any signed-in staff member can send a
// message to the support inbox; delivery goes through Resend (spec 0001's mailer), with the
// requester set as Reply-To so support can respond directly. The "to" address comes from env
// (SUPPORT_EMAIL / NEXT_PUBLIC_SUPPORT_EMAIL), matching the client's Contact-support link.
export const dynamic = "force-dynamic";

interface Env {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  SUPPORT_EMAIL?: string;
  NEXT_PUBLIC_SUPPORT_EMAIL?: string;
}

const MAX_SUBJECT = 200;
const MAX_MESSAGE = 5000;

export async function POST(req: Request) {
  const session = await getSession();
  const actor = await getActor();
  if (!session || !actor) {
    return Response.json({ ok: false, error: "Not signed in." }, { status: 401 });
  }

  let body: { subject?: string; message?: string };
  try {
    body = (await req.json()) as { subject?: string; message?: string };
  } catch {
    return Response.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  const subject = (body.subject ?? "").trim() || "Support request";
  if (!message) {
    return Response.json(
      { ok: false, error: "Please enter a message." },
      { status: 400 },
    );
  }
  if (message.length > MAX_MESSAGE || subject.length > MAX_SUBJECT) {
    return Response.json(
      { ok: false, error: "Your message is too long." },
      { status: 400 },
    );
  }

  const { env } = getCloudflareContext();
  const e = env as unknown as Env;
  const to =
    e.SUPPORT_EMAIL ?? e.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@americaworks.com";

  try {
    await sendEmail(
      {
        apiKey: e.RESEND_API_KEY,
        from: e.EMAIL_FROM ?? "no-reply@americaworks.com",
      },
      {
        to,
        subject: `[Support] ${subject}`,
        replyTo: session.user.email,
        html: supportRequestEmail({
          fromName: session.user.name,
          fromEmail: session.user.email,
          orgId: actor.orgId,
          subject,
          message,
        }),
      },
    );
  } catch {
    return Response.json(
      { ok: false, error: "Couldn't send your message. Please try again." },
      { status: 502 },
    );
  }

  return Response.json({ ok: true });
}
