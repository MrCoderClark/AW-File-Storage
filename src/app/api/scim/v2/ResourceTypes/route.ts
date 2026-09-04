import { getCloudflareContext } from "@opennextjs/cloudflare";
import { resolveScimOrg, type ScimEnv, scimError } from "@/server/scim";

// SCIM discovery (spec 0015): the resource types we serve (User only, v1).
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const env = getCloudflareContext().env as unknown as ScimEnv;
  const orgId = await resolveScimOrg(env, req.headers.get("authorization"));
  if (!orgId) return scimError("Unauthorized", 401);
  return Response.json(
    {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 1,
      Resources: [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "User",
          name: "User",
          endpoint: "/Users",
          schema: "urn:ietf:params:scim:schemas:core:2.0:User",
          meta: { resourceType: "ResourceType" },
        },
      ],
    },
    { headers: { "Content-Type": "application/scim+json" } },
  );
}
