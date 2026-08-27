import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { getAuth } from "./auth";
import { getDb } from "./db";
import * as schema from "./db/schema";
import { getSession } from "./session";

export interface ShellData {
  userName: string;
  userEmail: string;
  orgName: string;
  role: "owner" | "admin" | "member";
}

/** Everything the app shell needs about the signed-in caller. Null if no session. */
export async function getShellData(): Promise<ShellData | null> {
  const session = await getSession();
  if (!session) return null;

  const orgId = (session.session as { activeOrganizationId?: string | null })
    .activeOrganizationId;

  let orgName = "";
  let role: ShellData["role"] = "member";
  if (orgId) {
    const [org] = await getDb()
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, orgId))
      .limit(1);
    orgName = org?.name ?? "";
    const member = await getAuth().api.getActiveMember({
      headers: await headers(),
    });
    if (member?.role === "owner" || member?.role === "admin") role = member.role;
  }

  return {
    userName: session.user.name,
    userEmail: session.user.email,
    orgName,
    role,
  };
}
