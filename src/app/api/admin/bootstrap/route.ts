import { getCloudflareContext } from "@opennextjs/cloudflare";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { authPlugins, authSharedOptions } from "@/server/auth-options";
import { buildDb } from "@/server/db";
import * as schema from "@/server/db/schema";
import { uuidv7 } from "@/server/id";

// One-time production bootstrap of the first owner + organization. Guarded by
// the CRON_SECRET bearer token AND only runs when no users exist yet, so it is
// inert after initial setup. (Sign-up is otherwise disabled.)
export async function POST(req: Request) {
  const { env } = getCloudflareContext();
  const secret = (env as unknown as { CRON_SECRET?: string }).CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const db = buildDb(env.DB);
  const existing = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  if (existing.length > 0) {
    return Response.json({ ok: false, error: "Already initialized." }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    name?: string;
    orgName?: string;
  };
  if (!body.email || !body.password || !body.name || !body.orgName) {
    return new Response("Invalid input", { status: 400 });
  }

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

  const email = body.email.toLowerCase();
  await seedAuth.api.signUpEmail({
    body: { email, password: body.password, name: body.name },
  });
  await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.email, email));

  const [owner] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);

  const orgId = uuidv7();
  const slug =
    body.orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
    "org";
  await db.insert(schema.organization).values({
    id: orgId,
    name: body.orgName,
    slug,
    createdAt: new Date(),
  });
  await db.insert(schema.member).values({
    id: uuidv7(),
    organizationId: orgId,
    userId: owner.id,
    role: "owner",
    createdAt: new Date(),
  });

  return Response.json({ ok: true, email, orgId });
}
