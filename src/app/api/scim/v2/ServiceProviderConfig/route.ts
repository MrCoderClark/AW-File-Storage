import { getCloudflareContext } from "@opennextjs/cloudflare";
import { resolveScimOrg, type ScimEnv, scimError } from "@/server/scim";

// SCIM discovery (spec 0015): capabilities Entra reads during setup.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const env = getCloudflareContext().env as unknown as ScimEnv;
  const orgId = await resolveScimOrg(env, req.headers.get("authorization"));
  if (!orgId) return scimError("Unauthorized", 401);
  return Response.json(
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://www.awvcard.com",
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "OAuth Bearer Token",
          description: "Authentication via the SCIM bearer token.",
          primary: true,
        },
      ],
      meta: { resourceType: "ServiceProviderConfig" },
    },
    { headers: { "Content-Type": "application/scim+json" } },
  );
}
