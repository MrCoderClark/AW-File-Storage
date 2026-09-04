import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  resolveScimOrg,
  type ScimEnv,
  scimCreateUser,
  scimError,
  scimListJson,
  scimListUsers,
  toScimUserJson,
} from "@/server/scim";

// SCIM 2.0 Users collection (spec 0015). Bearer-token auth resolves the org; all
// ops are confined to it. GET supports Entra's `userName eq "..."` existence check.
export const dynamic = "force-dynamic";

const scimEnv = () => getCloudflareContext().env as unknown as ScimEnv;
const SCIM_JSON = { "Content-Type": "application/scim+json" };

export async function GET(req: Request) {
  const env = scimEnv();
  const orgId = await resolveScimOrg(env, req.headers.get("authorization"));
  if (!orgId) return scimError("Unauthorized", 401);

  const filter = new URL(req.url).searchParams.get("filter") ?? "";
  const m = filter.match(/userName eq "([^"]+)"/i);
  const users = await scimListUsers(env, orgId, m ? m[1] : undefined);
  return Response.json(scimListJson(users), { headers: SCIM_JSON });
}

export async function POST(req: Request) {
  const env = scimEnv();
  const orgId = await resolveScimOrg(env, req.headers.get("authorization"));
  if (!orgId) return scimError("Unauthorized", 401);

  const body = (await req.json().catch(() => null)) as {
    userName?: string;
    name?: { givenName?: string; familyName?: string };
  } | null;
  const userName = body?.userName;
  if (!userName || typeof userName !== "string") {
    return scimError("userName is required", 400);
  }
  try {
    const user = await scimCreateUser(env, orgId, {
      userName,
      givenName: body?.name?.givenName ?? null,
      familyName: body?.name?.familyName ?? null,
    });
    return Response.json(toScimUserJson(user), { status: 201, headers: SCIM_JSON });
  } catch {
    return scimError("Could not create the user", 400);
  }
}
