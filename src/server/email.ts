/**
 * Transactional email via Resend (spec 0001). Called from Better Auth's
 * sendResetPassword / sendVerificationEmail and from invitations.
 *
 * If no RESEND_API_KEY is configured (local dev), it falls back to logging the
 * message — including any link — to the console, so the flows are fully testable
 * without a Resend account. Real delivery activates automatically once the key
 * is set as a Worker secret.
 */
export interface EmailConfig {
  apiKey?: string;
  from: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(
  cfg: EmailConfig,
  msg: EmailMessage,
): Promise<void> {
  if (!cfg.apiKey) {
    console.log(
      `[email:fallback] to=${msg.to} subject="${msg.subject}"\n${msg.html}`,
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: cfg.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Never throw the recipient's address or the link into logs beyond this.
    console.error(`[email] Resend failed (${res.status}): ${detail}`);
    throw new Error("Failed to send email");
  }
}

/** A tiny escaped link block, shared by the auth emails. */
export function linkEmail(intro: string, url: string, cta: string): string {
  return `<p>${intro}</p><p><a href="${url}">${cta}</a></p><p>If you did not request this, you can ignore this email.</p>`;
}
