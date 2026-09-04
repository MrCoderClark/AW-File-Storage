import { and, eq, isNull, lte } from "drizzle-orm";
import { type AuthEnv, getAuth } from "./auth";
import { buildDb } from "./db";
import * as schema from "./db/schema";

/**
 * Send any DUE, unsent scheduled emails (spec 0015). Used for the SCIM
 * set-password email, deferred ~5 min so the new user's mailbox is provisioned.
 * A `scim_set_password` row triggers a Better Auth password reset (the branded
 * reset email), so the token is minted fresh at send time. Best effort per row —
 * a failure leaves it unsent for the next flush. Returns how many were sent.
 */
export async function flushPendingEmails(env: AuthEnv): Promise<{ sent: number }> {
  const db = buildDb(env.DB);
  const due = await db
    .select({
      id: schema.pendingEmail.id,
      kind: schema.pendingEmail.kind,
      userId: schema.pendingEmail.userId,
    })
    .from(schema.pendingEmail)
    .where(
      and(
        isNull(schema.pendingEmail.sentAt),
        lte(schema.pendingEmail.sendAfter, new Date()),
      ),
    )
    .limit(50);

  let sent = 0;
  for (const row of due) {
    try {
      if (row.kind === "scim_set_password") {
        const [u] = await db
          .select({ email: schema.user.email })
          .from(schema.user)
          .where(eq(schema.user.id, row.userId))
          .limit(1);
        if (u) {
          await getAuth().api.requestPasswordReset({
            body: { email: u.email, redirectTo: `${env.APP_URL}/reset-password` },
          });
        }
      }
      await db
        .update(schema.pendingEmail)
        .set({ sentAt: new Date() })
        .where(eq(schema.pendingEmail.id, row.id));
      sent++;
    } catch {
      // Leave unsent; the next flush retries.
    }
  }
  return { sent };
}
