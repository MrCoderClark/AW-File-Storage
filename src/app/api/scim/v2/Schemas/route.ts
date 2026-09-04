import { getCloudflareContext } from "@opennextjs/cloudflare";
import { resolveScimOrg, type ScimEnv, scimError } from "@/server/scim";

// SCIM discovery (spec 0015): the core User schema (the subset we support).
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
          id: "urn:ietf:params:scim:schemas:core:2.0:User",
          name: "User",
          description: "User Account",
          attributes: [
            { name: "userName", type: "string", required: true, uniqueness: "server" },
            {
              name: "name",
              type: "complex",
              subAttributes: [
                { name: "givenName", type: "string" },
                { name: "familyName", type: "string" },
              ],
            },
            { name: "active", type: "boolean" },
            { name: "emails", type: "complex", multiValued: true },
          ],
          meta: { resourceType: "Schema" },
        },
      ],
    },
    { headers: { "Content-Type": "application/scim+json" } },
  );
}
