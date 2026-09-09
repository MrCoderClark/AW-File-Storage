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
  /** Optional Reply-To (e.g. the requester on a support message), so a reply reaches them. */
  replyTo?: string;
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
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Never throw the recipient's address or the link into logs beyond this.
    console.error(`[email] Resend failed (${res.status}): ${detail}`);
    throw new Error("Failed to send email");
  }
}

/**
 * A branded action email — the shared shell + call-to-action button — for the
 * transactional links (password reset, email verification). Same look as the
 * invitation, without the invite-specific copy. `intro` is a plain sentence.
 */
export function linkEmail(
  intro: string,
  url: string,
  cta: string,
  name?: string | null,
): string {
  const content = `          <p style="margin:0 0 14px 0;">${greeting(name)}</p>
          <p style="margin:0 0 18px 0;">${escapeHtml(intro)}</p>
          ${button(url, cta)}
          <p style="margin:18px 0 14px 0;font-size:14px;color:${BRAND.muted};">Or paste this link into your browser:<br><a href="${escapeHtml(url)}" style="color:${BRAND.link};word-break:break-all;">${escapeHtml(url)}</a></p>
          <p style="margin:0;">If you did not request this, you can safely ignore this email.</p>`;
  return emailShell({ preheader: intro, contentHtml: content });
}


/**
 * A support request raised from the in-app "Contact support" form (spec 0025 follow-up).
 * Sent to the support inbox with the requester as Reply-To; the body carries who asked, from
 * which org, and their message. Every interpolated value is HTML-escaped.
 */
export function supportRequestEmail(opts: {
  fromName?: string | null;
  fromEmail: string;
  orgId: string;
  subject: string;
  message: string;
}): string {
  const who = opts.fromName?.trim()
    ? `${escapeHtml(opts.fromName)} &lt;${escapeHtml(opts.fromEmail)}&gt;`
    : escapeHtml(opts.fromEmail);
  const body = escapeHtml(opts.message).replace(/\r?\n/g, "<br>");
  const content = `          <p style="margin:0 0 14px 0;font-weight:700;">New support request</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;font-size:14px;color:${BRAND.muted};">
            <tr><td style="padding:2px 12px 2px 0;">From</td><td style="color:${BRAND.text};">${who}</td></tr>
            <tr><td style="padding:2px 12px 2px 0;">Organization</td><td style="color:${BRAND.text};">${escapeHtml(opts.orgId)}</td></tr>
            <tr><td style="padding:2px 12px 2px 0;">Subject</td><td style="color:${BRAND.text};">${escapeHtml(opts.subject)}</td></tr>
          </table>
          <div style="padding:14px 16px;background-color:${BRAND.canvas};border:1px solid ${BRAND.border};border-radius:8px;font-size:15px;line-height:23px;color:${BRAND.text};">${body}</div>
          <p style="margin:16px 0 0 0;font-size:14px;color:${BRAND.muted};">Reply directly to this email to respond to ${escapeHtml(opts.fromEmail)}.</p>`;
  return emailShell({
    preheader: `Support request: ${opts.subject}`,
    contentHtml: content,
    footerNote: "Sent from the AW File Storage in-app Contact support form.",
  });
}


const BRAND = {
  navy: "#0d2440", // --color-brand-900, the header bar
  accentSoft: "#a8d4f2", // the light blue call to action in the mock
  text: "#0f172a",
  muted: "#64748b", // --color-muted-500
  border: "#e2e8f0", // --color-border
  canvas: "#f5f7fa", // --color-canvas
  link: "#1f5d99", // --color-brand-600
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Escape text destined for HTML. Every interpolated value goes through this. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Morning / afternoon / evening in New York (Eastern) time. */
function partOfDayET(now: Date = new Date()): "morning" | "afternoon" | "evening" {
  const hour =
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hour12: false,
      }).format(now),
    ) % 24; // some runtimes render midnight as "24"
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/** The recipient's first name (HTML-escaped), or "" when it is unknown. */
function firstName(name?: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? escapeHtml(first) : "";
}

/**
 * A time-aware greeting line: "Good morning, Joseph," — or, when the recipient's
 * name is unknown (e.g. an invitation to someone with no account yet), just
 * "Good morning,". Eastern time so it reads correctly for AW's staff.
 */
function greeting(name?: string | null): string {
  const part = partOfDayET();
  const label =
    part === "morning"
      ? "Good morning"
      : part === "afternoon"
        ? "Good afternoon"
        : "Good evening";
  const first = firstName(name);
  return first ? `${label}, ${first},` : `${label},`;
}

/**
 * The shared chrome: navy brand bar, white card, small legal footer. Callers
 * supply only the middle. `preheader` is the grey preview line inboxes show
 * next to the subject, so it is worth setting deliberately.
 */
export function emailShell(opts: {
  preheader: string;
  contentHtml: string;
  /** The small grey footer line. Defaults to a generic automated-message note. */
  footerNote?: string;
}): string {
  const year = new Date().getUTCFullYear();
  const footerNote =
    opts.footerNote ?? "This is an automated message from AW File Storage.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>AW File Storage</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.canvas};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.canvas};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid ${BRAND.border};border-radius:8px;overflow:hidden;">
        <tr>
          <td align="center" style="background-color:${BRAND.navy};padding:16px 24px;font-family:${FONT};font-size:17px;line-height:26px;color:#ffffff;">
            <span style="font-weight:700;">AW File Storage</span>
            <span style="color:#9fb6d1;"> | Secure. Scalable. Simple.</span>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 32px 32px;font-family:${FONT};font-size:15px;line-height:23px;color:${BRAND.text};">
${opts.contentHtml}
          </td>
        </tr>
      </table>
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
        <tr>
          <td align="center" style="padding:16px 12px;font-family:${FONT};font-size:12px;line-height:18px;color:${BRAND.muted};">
            &copy; ${year} America Works. ${escapeHtml(footerNote)}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** The light blue call to action from the mock, built as a table so Outlook renders it. */
function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
  <tr>
    <td align="center" bgcolor="${BRAND.accentSoft}" style="border-radius:6px;">
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:${BRAND.navy};text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

const FEATURES: Array<[string, string]> = [
  [
    "Private by default",
    "Files land in storage only your organization can reach; nothing is public until you publish it.",
  ],
  [
    "Contact cards, ready to share",
    "Publish a staff contact card to a stable web link, with a QR code and a printable email signature.",
  ],
  [
    "Works in the browser",
    "Upload and manage everything from any device, with nothing to install.",
  ],
  [
    "Fully audited",
    "Every upload, publish, and deletion is recorded, so nothing is a mystery later.",
  ],
];

/**
 * The invitation email (spec 0005 AC-1). Styled to
 * `docs/Designs/mock-email-invite.jpg`; the copy is an invitation rather than
 * the mock's marketing pitch, because the button has to carry the recipient to
 * the accept page to set a password.
 */
export function inviteEmail(opts: {
  url: string;
  role: "admin" | "member";
  inviterName?: string;
  orgName?: string;
  expiresInDays: number;
  resent?: boolean;
}): string {
  const invitedBy = opts.inviterName
    ? `<strong>${escapeHtml(opts.inviterName)}</strong> has invited you`
    : "You have been invited";
  const bullets = FEATURES.map(
    ([label, text]) =>
      `            <li style="margin:0 0 7px 0;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(text)}</li>`,
  ).join("\n");

  const roleLine =
    opts.role === "admin"
      ? "You are being added as an <strong>administrator</strong>, so you will also be able to manage people and settings."
      : "You are being added as a <strong>member</strong>.";

  const content = `          <p style="margin:0 0 14px 0;">${greeting()}</p>
          <p style="margin:0 0 14px 0;">${
            opts.resent ? "Here is your invitation again. " : ""
          }${invitedBy} to <strong>AW File Storage</strong>, our secure place to store company files and publish contact cards.</p>
          <p style="margin:0 0 10px 0;">What you get:</p>
          <ul style="margin:0 0 16px 0;padding-left:22px;">
${bullets}
          </ul>
          <p style="margin:0 0 16px 0;"><strong>Set your password to get started:</strong></p>
          ${button(opts.url, "Accept invitation")}
          <p style="margin:18px 0 14px 0;font-size:14px;color:${BRAND.muted};">Or paste this link into your browser:<br><a href="${escapeHtml(opts.url)}" style="color:${BRAND.link};word-break:break-all;">${escapeHtml(opts.url)}</a></p>
          <p style="margin:0 0 14px 0;">${roleLine} This invitation expires in ${opts.expiresInDays} days, and the link works once.</p>
          <p style="margin:0 0 14px 0;">If you were not expecting this, you can ignore this email and no account is created.</p>
          <p style="margin:0 0 4px 0;">Best regards,</p>
          <p style="margin:0;">The AW File Storage Team</p>`;

  return emailShell({
    preheader: `${
      opts.inviterName ? `${opts.inviterName} invited you` : "You have been invited"
    } to AW File Storage. Set your password to get started.`,
    contentHtml: content,
    footerNote:
      "Sent because someone at your organization invited you to AW File Storage.",
  });
}
