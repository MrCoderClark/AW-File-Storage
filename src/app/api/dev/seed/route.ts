import { getCloudflareContext } from "@opennextjs/cloudflare";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { authPlugins, authSharedOptions } from "@/server/auth-options";
import { buildDb } from "@/server/db";
import * as schema from "@/server/db/schema";
import { uuidv7 } from "@/server/id";

/**
 * DEV-ONLY bootstrap for the first owner + organization. Because sign-up is
 * disabled in production, the first account must be seeded; in the real product
 * this becomes an admin CLI/one-time task. Guarded to non-production.
 *
 * Visit GET /api/dev/seed once, then sign in with the returned credentials.
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }

  const { env } = getCloudflareContext();
  const db = buildDb(env.DB);

  // A seed-only auth instance: sign-up enabled, no email verification, so we can
  // create the owner. Password hashing is identical to the runtime instance, so
  // the seeded user signs in normally afterward.
  const seedAuth = betterAuth({
    ...authSharedOptions,
    emailAndPassword: {
      ...authSharedOptions.emailAndPassword,
      disableSignUp: false,
      requireEmailVerification: false,
    },
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    secret: (env as unknown as { BETTER_AUTH_SECRET: string }).BETTER_AUTH_SECRET,
    baseURL: (env as unknown as { APP_URL: string }).APP_URL,
    plugins: authPlugins,
  });

  const email = "owner@americaworks.test";
  const password = "correct-horse-battery-staple-12";

  let signupError: string | null = null;
  try {
    await seedAuth.api.signUpEmail({ body: { email, password, name: "Owner" } });
  } catch (e) {
    signupError = e instanceof Error ? e.message : String(e);
  }

  // Mark verified so the real (verification-required) instance lets them in.
  await db
    .update(schema.user)
    .set({ emailVerified: true })
    .where(eq(schema.user.email, email));

  const [owner] = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, email));

  const existing = await db
    .select()
    .from(schema.member)
    .where(eq(schema.member.userId, owner.id));

  let orgId = existing[0]?.organizationId;
  if (!orgId) {
    orgId = uuidv7();
    await db.insert(schema.organization).values({
      id: orgId,
      name: "America Works",
      slug: "america-works",
      createdAt: new Date(),
    });
    await db.insert(schema.member).values({
      id: uuidv7(),
      organizationId: orgId,
      userId: owner.id,
      role: "owner",
      createdAt: new Date(),
    });
  }

  return Response.json({ ok: true, email, password, orgId, signupError });
}
