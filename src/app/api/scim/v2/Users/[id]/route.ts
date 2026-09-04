import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  resolveScimOrg,
  type ScimEnv,
  scimDeleteUser,
  scimError,
  scimGetUser,
  scimUpdateUser,
  toScimUserJson,
} from "@/server/scim";

// SCIM 2.0 Users/{id} (spec 0015). Bearer-token auth; confined to the token's org.
export const dynamic = "force-dynamic";

const scimEnv = () => getCloudflareContext().env as unknown as ScimEnv;
const SCIM_JSON = { "Content-Type": "application/scim+json" };

const toBool = (v: unknown): boolean =>
  v === true || v === "true" || v === "True" || v === 1;

interface UserPatch {
  givenName?: string | null;
  familyName?: string | null;
  userName?: string | null;
  active?: boolean;
}

async function auth(req: Request) {
  const env = scimEnv();
  const orgId = await resolveScimOrg(env, req.headers.get("authorization"));
  return { env, orgId };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { env, orgId } = await auth(req);
  if (!orgId) return scimError("Unauthorized", 401);
  const { id } = await ctx.params;
  const user = await scimGetUser(env, orgId, id);
  if (!user) return scimError("User not found", 404);
  return Response.json(toScimUserJson(user), { headers: SCIM_JSON });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { env, orgId } = await auth(req);
  if (!orgId) return scimError("Unauthorized", 401);
  const { id } = await ctx.params;
  const ok = await scimDeleteUser(env, orgId, id);
  return ok ? new Response(null, { status: 204 }) : scimError("User not found", 404);
}

// Full replace (Entra sometimes uses PUT): userName / name / active.
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { env, orgId } = await auth(req);
  if (!orgId) return scimError("Unauthorized", 401);
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    userName?: string;
    name?: { givenName?: string; familyName?: string };
    active?: unknown;
  };
  const updated = await scimUpdateUser(env, orgId, id, {
    userName: body.userName ?? null,
    givenName: body.name?.givenName ?? null,
    familyName: body.name?.familyName ?? null,
    active: body.active === undefined ? undefined : toBool(body.active),
  });
  if (!updated) return scimError("User not found", 404);
  return Response.json(toScimUserJson(updated), { headers: SCIM_JSON });
}

// Partial update (Entra's usual deactivation path). Tolerates the common shapes:
// {op, path:"active", value} and {op, value:{active|name|userName}}.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { env, orgId } = await auth(req);
  if (!orgId) return scimError("Unauthorized", 401);
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    Operations?: Array<{ op?: string; path?: string; value?: unknown }>;
  };

  const patch: UserPatch = {};
  for (const op of body.Operations ?? []) {
    const path = (op.path ?? "").toLowerCase();
    const value = op.value as
      | { active?: unknown; userName?: string; name?: { givenName?: string; familyName?: string } }
      | unknown;
    if (path === "active") patch.active = toBool(value);
    else if (path === "username") patch.userName = String(value);
    else if (path === "name.givenname") patch.givenName = value == null ? null : String(value);
    else if (path === "name.familyname") patch.familyName = value == null ? null : String(value);
    else if (path === "" && value && typeof value === "object") {
      const v = value as {
        active?: unknown;
        userName?: string;
        name?: { givenName?: string; familyName?: string };
      };
      if ("active" in v) patch.active = toBool(v.active);
      if (v.userName) patch.userName = v.userName;
      if (v.name?.givenName !== undefined) patch.givenName = v.name.givenName ?? null;
      if (v.name?.familyName !== undefined) patch.familyName = v.name.familyName ?? null;
    }
  }

  const updated = await scimUpdateUser(env, orgId, id, patch);
  if (!updated) return scimError("User not found", 404);
  return Response.json(toScimUserJson(updated), { headers: SCIM_JSON });
}
